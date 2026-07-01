import SwiftUI

struct WatchGameView: View {
    @EnvironmentObject private var model: WatchGameModel
    @State private var overflowOpen = false
    @State private var subPickerOpen = false

    var body: some View {
        if let session = model.session, !session.eventId.isEmpty {
            liveView(session)
        } else {
            idleView
        }
    }

    private var idleView: some View {
        VStack(spacing: 8) {
            gkBadge(size: 44)
            Text("GoalKickr")
                .font(.headline)
            Text("Start GameDay on your phone.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal)
    }

    // MARK: - Live view

    private func liveView(_ session: WatchGameSession) -> some View {
        ScrollView {
            VStack(spacing: 8) {
                headerRow(session)
                scoreBoard(session)
                divider
                subCountdown(session)
                quickSubButton(session)
                if !model.lastActionStatus.isEmpty {
                    Text(model.lastActionStatus)
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    // MARK: - Header (GK badge · LIVE pill · overflow)

    private func headerRow(_ session: WatchGameSession) -> some View {
        HStack(alignment: .center) {
            gkBadge(size: 30)
            Spacer()
            VStack(spacing: 1) {
                if session.isLive {
                    HStack(spacing: 3) {
                        Circle().fill(Color.red).frame(width: 5, height: 5)
                        Text("LIVE")
                            .font(.system(size: 12, weight: .black))
                            .foregroundStyle(.red)
                    }
                } else {
                    Text(session.status.uppercased())
                        .font(.system(size: 10, weight: .black))
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            Button {
                overflowOpen = true
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .heavy))
                    .foregroundStyle(.white)
                    .frame(width: 30, height: 20)
            }
            .buttonStyle(.plain)
            .sheet(isPresented: $overflowOpen) {
                overflowSheet(session)
            }
        }
    }

    // GoalKickr badge — real brand asset (Assets.xcassets/GKBadge).
    // To refresh: replace ios/App/CoachWatch Watch App/
    // Assets.xcassets/GKBadge.imageset/logo.png with a new PNG (must
    // keep the same filename).
    private func gkBadge(size: CGFloat) -> some View {
        Image("GKBadge")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(width: size, height: size)
    }

    // MARK: - Scoreboard

    private func scoreBoard(_ session: WatchGameSession) -> some View {
        HStack(alignment: .top, spacing: 4) {
            teamColumn(name: session.homeName, score: session.ourScore, isOurs: true)
            centerColumn(session).frame(width: 54)
            teamColumn(name: session.opponentName, score: session.oppScore, isOurs: false)
        }
    }

    private func centerColumn(_ session: WatchGameSession) -> some View {
        VStack(spacing: 3) {
            Text(ordinalPeriod(session.periodLabel))
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.secondary)
            Text(formatWatchClock(model.liveClockSeconds()))
                .font(.system(size: 18, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
        }
        .padding(.top, 26) // sit below team labels so scores stay top-aligned
    }

    // Our column: red block, white score, red +/- circles
    // Their column: white block, black score, white +/- circles w/ red icons
    private func teamColumn(name: String, score: Int, isOurs: Bool) -> some View {
        let blockFill: Color = isOurs ? .red : .white
        let scoreColor: Color = isOurs ? .white : .black
        let circleFill: Color = isOurs ? .red : .white
        let iconColor: Color = isOurs ? .white : .red

        return VStack(spacing: 5) {
            Text(shortName(name))
                .font(.system(size: 12, weight: .black))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(blockFill)
                .frame(height: 54)
                .overlay(
                    Text("\(score)")
                        .font(.system(size: 38, weight: .black, design: .rounded))
                        .foregroundStyle(scoreColor)
                        .minimumScaleFactor(0.6)
                )

            HStack(spacing: 6) {
                circleButton(system: "minus", fill: circleFill, icon: iconColor) {
                    model.send(isOurs ? "ourGoalMinus" : "oppGoalMinus")
                }
                circleButton(system: "plus", fill: circleFill, icon: iconColor) {
                    model.send(isOurs ? "ourGoal" : "oppGoal")
                }
            }
        }
    }

    private func circleButton(system: String, fill: Color, icon: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            ZStack {
                Circle().fill(fill)
                Image(systemName: system)
                    .font(.system(size: 13, weight: .heavy))
                    .foregroundStyle(icon)
            }
            .frame(width: 26, height: 26)
        }
        .buttonStyle(.plain)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.15))
            .frame(height: 1)
            .padding(.horizontal, 4)
    }

    // MARK: - Next Sub countdown
    //
    // Persistent display (not gated on "due now") so the coach always
    // knows where the shift bell is at. When the timer hits 0, the
    // WatchGameModel fires a haptic and the Quick Sub button below
    // switches to its "Sub now" state.

    private func subCountdown(_ session: WatchGameSession) -> some View {
        let remaining = model.secondsUntilSub()
        return VStack(spacing: 3) {
            Text("NEXT SUB")
                .font(.system(size: 11, weight: .black))
                .foregroundStyle(.secondary)

            if let remaining {
                HStack(alignment: .lastTextBaseline, spacing: 3) {
                    Text("\(remaining / 60)")
                        .font(.system(size: 26, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                    Text(":")
                        .font(.system(size: 22, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                    Text(String(format: "%02d", remaining % 60))
                        .font(.system(size: 26, weight: .black, design: .rounded))
                        .foregroundStyle(.white)
                }
                .monospacedDigit()
                HStack(spacing: 22) {
                    Text("MIN")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                    Text("SEC")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("Off")
                    .font(.system(size: 22, weight: .black, design: .rounded))
                    .foregroundStyle(.white)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
    }

    // MARK: - Quick Sub CTA

    private func quickSubButton(_ session: WatchGameSession) -> some View {
        let dueNow = (model.secondsUntilSub() ?? -1) == 0
        return Button(action: {
            // Empty bench (no one to sub in) falls back to just
            // acknowledging the bell — coach's field roster is
            // presumably complete and the bell needs silencing.
            if session.bench.isEmpty {
                model.send("subMade")
            } else {
                subPickerOpen = true
            }
        }) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 13, weight: .heavy))
                Text(dueNow ? "SUB NOW" : "QUICK SUB")
                    .font(.system(size: 14, weight: .black))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
        .sheet(isPresented: $subPickerOpen) {
            subPickerSheet(session)
        }
    }

    // MARK: - Sub picker
    //
    // Scrollable list of bench players; Digital Crown scrolls
    // naturally through it. First name is the recognition anchor
    // (bold, large); jersey shows as a small tag pill on the right.
    // Bench is pre-sorted least-minutes-first by the phone, so the
    // top of the list is the coach's most likely pick.
    //
    // On tap we send `subMade` + playerId; phone auto-picks the
    // longest-on-field player to come off and shows an 8-second undo
    // toast if the tap was wrong.

    private func subPickerSheet(_ session: WatchGameSession) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("SUB IN")
                    .font(.system(size: 11, weight: .black))
                    .foregroundStyle(.secondary)
                    .tracking(1.5)
                Spacer()
                Button("Cancel") { subPickerOpen = false }
                    .font(.system(size: 12, weight: .bold))
                    .buttonStyle(.plain)
                    .foregroundStyle(.red)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)

            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(session.bench) { player in
                        Button {
                            model.send("subMade", playerId: player.id)
                            subPickerOpen = false
                        } label: {
                            HStack(spacing: 8) {
                                Text(firstName(player.name))
                                    .font(.system(size: 16, weight: .black))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                if let n = player.jerseyNumber {
                                    Text("#\(n)")
                                        .font(.system(size: 12, weight: .black, design: .rounded))
                                        .foregroundStyle(.white.opacity(0.7))
                                        .monospacedDigit()
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 2)
                                        .background(
                                            RoundedRectangle(cornerRadius: 6)
                                                .fill(Color.white.opacity(0.12))
                                        )
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 10)
                                    .fill(Color.red.opacity(0.85))
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    private func firstName(_ full: String) -> String {
        let parts = full.split(separator: " ")
        guard let first = parts.first else { return full }
        return String(first)
    }

    // MARK: - Overflow (Menu is watchOS-unavailable, so use a sheet)

    private func overflowSheet(_ session: WatchGameSession) -> some View {
        VStack(spacing: 8) {
            Button {
                model.send("undoLast")
                overflowOpen = false
            } label: {
                Label("Undo last", systemImage: "arrow.uturn.backward")
                    .frame(maxWidth: .infinity)
            }
            .tint(.orange)

            if session.isLive {
                Button {
                    model.send("pauseClock")
                    overflowOpen = false
                } label: {
                    Label("Pause clock", systemImage: "pause.fill")
                        .frame(maxWidth: .infinity)
                }
                .tint(.yellow)
            } else {
                Button {
                    model.send("startClock")
                    overflowOpen = false
                } label: {
                    Label("Start clock", systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .tint(.green)
            }

            Button("Close") { overflowOpen = false }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
        .padding()
    }

    // MARK: - Helpers

    private func shortName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 9 { return trimmed.uppercased() }
        return String(trimmed.prefix(9)).uppercased()
    }

    private func ordinalPeriod(_ label: String) -> String {
        let trimmed = label.uppercased()
        if trimmed == "OT" || trimmed == "HT" { return trimmed }
        switch trimmed {
        case "1": return "1ST"
        case "2": return "2ND"
        case "3": return "3RD"
        case "4": return "4TH"
        default: return trimmed
        }
    }
}

#Preview {
    let model = WatchGameModel()
    model.session = WatchGameSession(
        eventId: "preview",
        homeName: "Raptors",
        opponentName: "United FC",
        ourScore: 2,
        oppScore: 1,
        status: "live",
        periodLabel: "2",
        clockOffsetSeconds: 1725,
        clockStartedAtMs: Date().timeIntervalSince1970 * 1000 - 15_000,
        shiftSeconds: 300,
        lastBellAtSec: 1520,
        bellEnabled: true,
        suggestedNextPlayerName: "J. Anderson",
        bench: [
            WatchBenchPlayer(id: "1", name: "Aiden Kim", jerseyNumber: 14),
            WatchBenchPlayer(id: "2", name: "Mia Chen", jerseyNumber: 7),
            WatchBenchPlayer(id: "3", name: "Jordan Ruiz", jerseyNumber: 23),
            WatchBenchPlayer(id: "4", name: "Sam Patel", jerseyNumber: 5),
        ],
        updatedAt: Date().timeIntervalSince1970 * 1000
    )
    return WatchGameView().environmentObject(model)
}
