import AVFoundation
import Foundation

enum AudioHelperError: Error, CustomStringConvertible {
    case usage
    case invalidArgument(String)
    case noPlayers
    case schedulingFailed

    var description: String {
        switch self {
        case .usage:
            return "usage: notification-audio --volume FACTOR --repeat COUNT --delay-ms MILLISECONDS FILE"
        case let .invalidArgument(argument):
            return "invalid argument: \(argument)"
        case .noPlayers:
            return "no audio players were created"
        case .schedulingFailed:
            return "audio scheduling failed"
        }
    }
}

func argumentValue(_ arguments: [String], named name: String) throws -> String {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        throw AudioHelperError.usage
    }
    return arguments[index + 1]
}

func finiteDouble(_ value: String, named name: String) throws -> Double {
    guard let parsed = Double(value), parsed.isFinite else {
        throw AudioHelperError.invalidArgument(name)
    }
    return parsed
}

func boundedInteger(_ value: String, named name: String, minimum: Int, maximum: Int) throws -> Int {
    guard let parsed = Int(value), (minimum...maximum).contains(parsed) else {
        throw AudioHelperError.invalidArgument(name)
    }
    return parsed
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 7, arguments.last != nil else {
        throw AudioHelperError.usage
    }

    let volume = try finiteDouble(argumentValue(arguments, named: "--volume"), named: "--volume")
    let repeatCount = try boundedInteger(
        argumentValue(arguments, named: "--repeat"),
        named: "--repeat",
        minimum: 1,
        maximum: 10,
    )
    let delayMs = try finiteDouble(argumentValue(arguments, named: "--delay-ms"), named: "--delay-ms")
    guard delayMs >= 0 else { throw AudioHelperError.invalidArgument("--delay-ms") }

    let fileURL = URL(fileURLWithPath: arguments.last ?? "")
    let audioFile = try AVAudioFile(forReading: fileURL)
    let engine = AVAudioEngine()
    let mixer = AVAudioMixerNode()
    let gain = AVAudioUnitEQ(numberOfBands: 0)
    let playerVolume = Float(min(max(volume, 0), 4))
    let gainDb = playerVolume == 0 ? -96 : min(max(20 * log10(playerVolume), -96), 24)
    gain.globalGain = Float(gainDb)
    engine.attach(mixer)
    engine.attach(gain)

    var players: [AVAudioPlayerNode] = []
    players.reserveCapacity(repeatCount)
    for _ in 0..<repeatCount {
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: mixer, format: audioFile.processingFormat)
        player.volume = 1
        players.append(player)
    }
    engine.connect(mixer, to: gain, format: audioFile.processingFormat)
    engine.connect(gain, to: engine.mainMixerNode, format: audioFile.processingFormat)
    engine.prepare()

    try engine.start()
    guard let anchor = players.first,
          let anchorRenderTime = anchor.lastRenderTime else {
        throw AudioHelperError.schedulingFailed
    }
    let sampleRate = audioFile.processingFormat.sampleRate
    let leadInFrames = AVAudioFramePosition(sampleRate * 0.05)
    let delayFrames = AVAudioFramePosition(sampleRate * delayMs / 1_000)
    let anchorStart = anchorRenderTime.sampleTime + leadInFrames

    for (index, player) in players.enumerated() {
        guard player.lastRenderTime != nil else {
            throw AudioHelperError.schedulingFailed
        }
        let start = anchorStart + AVAudioFramePosition(index) * delayFrames
        let startTime = AVAudioTime(sampleTime: start, atRate: sampleRate)
        player.scheduleFile(audioFile, at: startTime, completionHandler: nil)
        player.play()
    }

    let longestDuration = Double(audioFile.length) / sampleRate
    let finishAfter = 0.05 + longestDuration + Double(repeatCount - 1) * delayMs / 1_000 + 0.25
    RunLoop.main.run(until: Date(timeIntervalSinceNow: finishAfter))
} catch {
    FileHandle.standardError.write(Data("notification-audio: \(error)\n".utf8))
    exit(EXIT_FAILURE)
}
