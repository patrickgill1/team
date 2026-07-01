import SwiftUI

struct WatchGameView: View {
    @EnvironmentObject private var model: WatchGameModel

    var body: some View {
        if let session = model.session, !session.eventId.isEmpty {
            liveView(session)
        } else {
            idleView
        }
    }

    private var idleView: some View {
        VStack(spacing: 8) {
            Image(systemName: "soccerball")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.red)
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
            VStack(spacing: 10) {
                header(session)
                scoreboard(session)
                subsSection(session)
                quickSubButton
                if !model.lastActionStatus.isEmpty {
                    Text(model.lastActionStatus)
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    // MARK: - Header (GK logo · LIVE pill · overflow menu)

    private func header(_ session: WatchGameSession) -> some View {
        HStack(alignment: .center, spacing: 6) {
            // Brand mark left. Real asset later; hexagon-approximation now.
            ZStack {
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color.black)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.red, lineWidth: 1.2)
                    )
                Text("GK")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(.white)
            }
            .frame(width: 26, height: 26)

            Spacer(minLength: 4)

            // Status pill — LIVE = red dot + label; scheduled/final variants.
            statusPill(session)

            Spacer(minLength: 4)

            // Overflow menu — undo + pause/resume live here so the
            // main surface is only the primary score/sub actions.
            Menu {
                Button {
                    model.send("undoLast")
                } label: {
                    Label("Undo last", systemImage: "arrow.uturn.backward")
                }
                if session.isLive {
                    Button {
                        model.send("pauseClock")
                    } label: {
                        Label("Pause clock", systemImage: "pause.fill")
                    }
                } else {
                    Button {
                        model.send("startClock")
                    } label: {
                        Label("Start clock", systemImage: "play.fill")
                    }
                }
            } label: {
                ZStack {
                    Circle().fill(Color.white.opacity(0.12))
                    Image(systemName: "ellipsis")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 26, height: 26)
            }
        }
    }

    private func statusPill(_ session: WatchGameSession) -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(session.isLive ? Color.red : Color.orange)
                .frame(width: 6, height: 6)
            Text(session.status.uppercased())
                .font(.system(size: 10, weight: .black))
                .kerning(0.5)
                .foregroundStyle(session.isLive ? Color.red : Color.orange)
        }
    }

    // MARK: - Scoreboard (Us block + clock column + Them block)

    private func scoreboard(_ session: WatchGameSession) -> some View {
        HStack(alignment: .top, spacing: 4) {
            teamColumn(
                name: session.homeName,
                score: session.ourScore,
                theirScore: session.oppScore,
                isOurs: true
            )

            clockColumn(session)
                .frame(width: 46)

            teamColumn(
                name: session.opponentName,
                score: session.oppScore,
                theirScore: session.ourScore,
                isOurs: false
            )
        }
    }

    private func clockColumn(_ session: WatchGameSession) -> some View {
        VStack(spacing: 2) {
            Text(ordinalPeriod(session.periodLabel))
                .font(.system(size: 10, weight: .black))
                .foregroundStyle(.secondary)
            Text(formatWatchClock(model.liveClockSeconds()))
                .font(.system(size: 15, weight: .black, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white)
        }
        .padding(.top, 12)
    }

    private func teamColumn(name: String, score: Int, theirScore: Int, isOurs: Bool) -> some View {
        let leading = score > theirScore
        // Winning team's block is filled (crimson if it's us, bone-white
        // if it's the opponent). Trailing team's block is a low-fill
        // slab of the same tint so the color language stays consistent
        // without shouting.
        let fill: Color = leading
            ? (isOurs ? .red : .white)
            : (isOurs ? Color.red.opacity(0.18) : Color.white.opacity(0.14))
        let scoreColor: Color = leading
            ? (isOurs ? .white : .black)
            : (isOurs ? .red : .white)

        return VStack(spacing: 4) {
            Text(shortName(name))
                .font(.system(size: 10, weight: .black))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            ZStack {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(fill)
                Text("\(score)")
                    .font(.system(size: 30, weight: .black, design: .rounded))
                    .foregroundStyle(scoreColor)
                    .minimumScaleFactor(0.6)
            }
            .frame(height: 46)

            HStack(spacing: 4) {
                scoreButton(system: "minus", tint: .red) {
                    model.send(isOurs ? "ourGoalMinus" : "oppGoalMinus")
                }
                scoreButton(system: "plus", tint: .red) {
                    model.send(isOurs ? "ourGoal" : "oppGoal")
                }
            }
        }
    }

    private func scoreButton(system: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 12, weight: .heavy))
                .frame(maxWidth: .infinity)
                .frame(height: 22)
                .background(RoundedRectangle(cornerRadius: 5).fill(tint.opacity(0.2)))
                .foregroundStyle(tint)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Subs section

    private func subsSection(_ session: WatchGameSession) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("SUBS")
                .font(.system(size: 10, weight: .black))
                .foregroundStyle(.secondary)

            if let name = session.suggestedNextPlayerName, !name.isEmpty {
                subRow(kind: "NEXT", kindTint: Color.green, jersey: nil, name: name, minute: nil)
            } else {
                Text("No pending subs")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
    }

    private func subRow(kind: String, kindTint: Color, jersey: Int?, name: String, minute: Int?) -> some View {
        HStack(spacing: 6) {
            Text(kind)
                .font(.system(size: 9, weight: .black))
                .padding(.horizontal, 4).padding(.vertical, 1.5)
                .background(RoundedRectangle(cornerRadius: 3).fill(kindTint.opacity(0.25)))
                .foregroundStyle(kindTint)
            if let jersey {
                Text("#\(jersey)")
                    .font(.system(size: 10, weight: .black))
                    .foregroundStyle(.secondary)
            }
            Text(shortDisplayName(name))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
            Spacer(minLength: 4)
            if let minute {
                Text("\(minute)'")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
    }

    // MARK: - Quick Sub CTA

    private var quickSubButton: some View {
        Button(action: { model.send("subMade") }) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.left.arrow.right")
                    .font(.system(size: 12, weight: .heavy))
                Text("Quick Sub")
                    .font(.system(size: 13, weight: .heavy))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 5)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
    }

    // MARK: - Helpers

    private func shortName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 8 { return trimmed.uppercased() }
        return String(trimmed.prefix(8)).uppercased()
    }

    private func shortDisplayName(_ value: String) -> String {
        // First + last-initial for the sub row so long names don't push
        // the minute stamp off-screen. "Julian Anderson" → "J. Anderson".
        let parts = value.split(separator: " ").map(String.init)
        guard parts.count > 1, let first = parts.first?.first else { return value }
        return "\(first). \(parts.dropFirst().joined(separator: " "))"
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
        lastBellAtSec: 1600,
        bellEnabled: true,
        suggestedNextPlayerName: "J. Anderson",
        updatedAt: Date().timeIntervalSince1970 * 1000
    )
    return WatchGameView().environmentObject(model)
}
