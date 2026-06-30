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
                .foregroundStyle(.cyan)
            Text("GoalKickr")
                .font(.headline)
            Text("Start GameDay on your phone.")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal)
    }

    private func liveView(_ session: WatchGameSession) -> some View {
        ScrollView {
            VStack(spacing: 10) {
                header(session)
                score(session)
                subCard(session)
                actions(session)
                if !model.lastActionStatus.isEmpty {
                    Text(model.lastActionStatus)
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func header(_ session: WatchGameSession) -> some View {
        VStack(spacing: 2) {
            HStack(spacing: 5) {
                Circle()
                    .fill(session.isLive ? .green : .orange)
                    .frame(width: 6, height: 6)
                Text(session.status.uppercased())
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                Spacer()
                Text("P\(session.periodLabel)")
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
            }
            Text(formatWatchClock(model.liveClockSeconds()))
                .font(.system(size: 28, weight: .black, design: .rounded))
                .monospacedDigit()
        }
    }

    private func score(_ session: WatchGameSession) -> some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(spacing: 2) {
                Text(shortName(session.homeName))
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(session.ourScore)")
                    .font(.system(size: 34, weight: .black, design: .rounded))
            }
            Text("-")
                .font(.title3.bold())
                .foregroundStyle(.secondary)
            VStack(spacing: 2) {
                Text(shortName(session.opponentName))
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text("\(session.oppScore)")
                    .font(.system(size: 34, weight: .black, design: .rounded))
            }
        }
        .monospacedDigit()
    }

    private func subCard(_ session: WatchGameSession) -> some View {
        Button(action: { model.send("subMade") }) {
            VStack(spacing: 3) {
                Text("SUB")
                    .font(.system(size: 11, weight: .black))
                    .foregroundStyle(.cyan)
                if let remaining = model.secondsUntilSub() {
                    Text(remaining == 0 ? "Now" : formatWatchClock(remaining))
                        .font(.system(size: 23, weight: .black, design: .rounded))
                        .monospacedDigit()
                } else {
                    Text("Off")
                        .font(.system(size: 23, weight: .black, design: .rounded))
                }
                if let name = session.suggestedNextPlayerName, !name.isEmpty {
                    Text("Next: \(firstName(name))")
                        .font(.caption2.bold())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(.cyan)
    }

    private func actions(_ session: WatchGameSession) -> some View {
        Grid(horizontalSpacing: 6, verticalSpacing: 6) {
            GridRow {
                actionButton("+ Us", system: "plus.circle.fill", tint: .green) { model.send("ourGoal") }
                actionButton("+ Them", system: "plus.circle.fill", tint: .red) { model.send("oppGoal") }
            }
            GridRow {
                actionButton("Undo", system: "arrow.uturn.backward.circle.fill", tint: .orange) { model.send("undoLast") }
                if session.isLive {
                    actionButton("Pause", system: "pause.circle.fill", tint: .yellow) { model.send("pauseClock") }
                } else {
                    actionButton("Resume", system: "play.circle.fill", tint: .green) { model.send("startClock") }
                }
            }
        }
    }

    private func actionButton(_ title: String, system: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: system)
                .labelStyle(.titleAndIcon)
                .font(.caption2.bold())
                .lineLimit(1)
        }
        .buttonStyle(.bordered)
        .tint(tint)
    }

    private func shortName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count <= 8 { return trimmed }
        return String(trimmed.prefix(8))
    }

    private func firstName(_ value: String) -> String {
        value.split(separator: " ").first.map(String.init) ?? value
    }
}

#Preview {
    let model = WatchGameModel()
    model.session = WatchGameSession(
        eventId: "preview",
        homeName: "Eagles",
        opponentName: "United",
        ourScore: 2,
        oppScore: 1,
        status: "live",
        periodLabel: "2",
        clockOffsetSeconds: 1820,
        clockStartedAtMs: Date().timeIntervalSince1970 * 1000 - 18_000,
        shiftSeconds: 300,
        lastBellAtSec: 1600,
        bellEnabled: true,
        suggestedNextPlayerName: "Mia Johnson",
        updatedAt: Date().timeIntervalSince1970 * 1000
    )
    return WatchGameView().environmentObject(model)
}
