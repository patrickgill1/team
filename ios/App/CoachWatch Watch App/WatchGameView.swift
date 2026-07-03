import SwiftUI

// Kinds accepted by the Watch stat picker. String rawValue matches
// TimelineEntry.kind on the phone side (goal, assist, save, yellow,
// red) so no translation is needed — payload passes through the
// bridge and the phone dispatches straight into addTimelineEntry.
enum WatchStatKind: String, CaseIterable, Identifiable {
    case goal
    case assist
    case save
    case yellow
    case red
    var id: String { rawValue }
    var label: String {
        switch self {
        case .goal:   return "Goal"
        case .assist: return "Assist"
        case .save:   return "Save"
        case .yellow: return "Yellow"
        case .red:    return "Red"
        }
    }
    var systemImage: String {
        switch self {
        case .goal:   return "soccerball"
        case .assist: return "hand.thumbsup.fill"
        case .save:   return "hand.raised.fill"
        case .yellow: return "square.fill"
        case .red:    return "square.fill"
        }
    }
    var tint: Color {
        switch self {
        case .goal:   return .red
        case .assist: return .blue
        case .save:   return .green
        case .yellow: return .yellow
        case .red:    return Color(red: 0.86, green: 0.15, blue: 0.15)
        }
    }
}

struct WatchGameView: View {
    @EnvironmentObject private var model: WatchGameModel
    @State private var overflowOpen = false
    @State private var subPickerOpen = false
    // Two-stage stat flow: statKindPickerOpen shows the 5-way grid
    // (Goal / Assist / Save / Yellow / Red). Once a kind is chosen,
    // pendingStatKind flips and statPlayerPickerOpen shows the
    // roster picker. Player tap sends `recordStat` and both sheets
    // close. Kept as two states (not a Bool + optional) so SwiftUI's
    // sheet(isPresented:) can drive them independently.
    @State private var statKindPickerOpen = false
    @State private var statPlayerPickerOpen = false
    @State private var pendingStatKind: WatchStatKind? = nil

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
            teamColumn(session: session, name: session.homeName, score: session.ourScore, isOurs: true)
            centerColumn(session).frame(width: 54)
            teamColumn(session: session, name: session.opponentName, score: session.oppScore, isOurs: false)
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

    // Asymmetric team columns:
    //  - Ours: score block + "+ STAT" pill (opens the attribution flow)
    //  - Theirs: score block + minus/plus circles (no attribution needed)
    // The design mirrors the reality — a coach only cares WHO on
    // their own team scored/saved/carded. Opponent stats are just
    // scoreboard maintenance.
    private func teamColumn(session: WatchGameSession, name: String, score: Int, isOurs: Bool) -> some View {
        let blockFill: Color = isOurs ? .red : .white
        let scoreColor: Color = isOurs ? .white : .black

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

            if isOurs {
                // Single "+ STAT" pill. Opens the stat-kind picker
                // when the roster is loaded; falls back to a raw
                // ourGoal (unattributed) when the roster is empty.
                Button {
                    if session.roster.isEmpty {
                        model.send("ourGoal")
                    } else {
                        statKindPickerOpen = true
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .heavy))
                        Text("STAT")
                            .font(.system(size: 11, weight: .black))
                            .tracking(0.5)
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(Color.red.opacity(0.9))
                    )
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $statKindPickerOpen) {
                    statKindPickerSheet()
                }
            } else {
                HStack(spacing: 6) {
                    circleButton(system: "minus", fill: .white, icon: .red) {
                        model.send("oppGoalMinus")
                    }
                    circleButton(system: "plus", fill: .white, icon: .red) {
                        model.send("oppGoal")
                    }
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

    // MARK: - Stat picker (kind + player, two sheets)

    private func statKindPickerSheet() -> some View {
        VStack(spacing: 8) {
            HStack {
                Text("STAT")
                    .font(.system(size: 11, weight: .black))
                    .foregroundStyle(.secondary)
                    .tracking(1.5)
                Spacer()
                Button("Cancel") {
                    statKindPickerOpen = false
                    pendingStatKind = nil
                }
                .font(.system(size: 12, weight: .bold))
                .buttonStyle(.plain)
                .foregroundStyle(.red)
            }
            .padding(.horizontal, 4)

            // 5 stat kinds — Goal, Assist, Save, Yellow, Red — laid out
            // as a vertical stack. Digital Crown scrolls. Simpler than
            // a grid on a 41mm face and easier tap targets.
            ScrollView {
                LazyVStack(spacing: 6) {
                    ForEach(WatchStatKind.allCases) { kind in
                        Button {
                            pendingStatKind = kind
                            statKindPickerOpen = false
                            // Chain to the player picker on the next
                            // runloop so SwiftUI can dismiss the first
                            // sheet before presenting the second.
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                                statPlayerPickerOpen = true
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: kind.systemImage)
                                    .font(.system(size: 14, weight: .heavy))
                                Text(kind.label.uppercased())
                                    .font(.system(size: 15, weight: .black))
                                Spacer()
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .frame(maxWidth: .infinity)
                            .background(
                                RoundedRectangle(cornerRadius: 10)
                                    .fill(kind.tint.opacity(0.9))
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 4)
        .sheet(isPresented: $statPlayerPickerOpen) {
            statPlayerPickerSheet()
        }
    }

    private func statPlayerPickerSheet() -> some View {
        let kind = pendingStatKind
        let roster = model.session?.roster ?? []
        return VStack(spacing: 0) {
            HStack {
                Text(kind?.label.uppercased() ?? "STAT")
                    .font(.system(size: 11, weight: .black))
                    .foregroundStyle(.secondary)
                    .tracking(1.5)
                Spacer()
                Button("Cancel") {
                    statPlayerPickerOpen = false
                    pendingStatKind = nil
                }
                .font(.system(size: 12, weight: .bold))
                .buttonStyle(.plain)
                .foregroundStyle(.red)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)

            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(roster) { player in
                        Button {
                            if let kind {
                                model.send("recordStat", playerId: player.id, stat: kind.rawValue)
                            }
                            statPlayerPickerOpen = false
                            pendingStatKind = nil
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
                                    .fill((kind?.tint ?? .red).opacity(0.85))
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(.top, 4)
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

            // Advance the period without leaving the Watch. Phone
            // side steps 1 → 2 → OT and resets the clock offset.
            Button {
                model.send("endPeriod")
                overflowOpen = false
            } label: {
                Label("End period", systemImage: "forward.end.fill")
                    .frame(maxWidth: .infinity)
            }
            .tint(.blue)

            // Silence the shift bell for the rest of the game — or
            // bring it back if it was already off. Handy for the last
            // few minutes when subs don't matter anymore.
            Button {
                model.send("toggleBell")
                overflowOpen = false
            } label: {
                Label(
                    session.bellEnabled ? "Silence sub bell" : "Enable sub bell",
                    systemImage: session.bellEnabled ? "bell.slash.fill" : "bell.fill"
                )
                .frame(maxWidth: .infinity)
            }
            .tint(.purple)

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
        roster: [
            WatchRosterPlayer(id: "1", name: "Aiden Kim", jerseyNumber: 14),
            WatchRosterPlayer(id: "2", name: "Mia Chen", jerseyNumber: 7),
            WatchRosterPlayer(id: "3", name: "Jordan Ruiz", jerseyNumber: 23),
            WatchRosterPlayer(id: "4", name: "Sam Patel", jerseyNumber: 5),
            WatchRosterPlayer(id: "5", name: "Alex Morgan", jerseyNumber: 10),
            WatchRosterPlayer(id: "6", name: "Chris Diaz", jerseyNumber: 2),
        ],
        updatedAt: Date().timeIntervalSince1970 * 1000
    )
    return WatchGameView().environmentObject(model)
}
