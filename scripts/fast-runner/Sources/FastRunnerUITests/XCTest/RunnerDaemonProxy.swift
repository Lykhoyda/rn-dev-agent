import Foundation

enum FastRunnerError: Error, LocalizedError {
    case missingPrivateAPI(String)

    var errorDescription: String? {
        switch self {
        case .missingPrivateAPI(let name): return "Private API unavailable: \(name)"
        }
    }
}

@MainActor
final class RunnerDaemonProxy {
    private let proxy: NSObject

    init() throws {
        guard let clazz = NSClassFromString("XCTRunnerDaemonSession") else {
            throw FastRunnerError.missingPrivateAPI("XCTRunnerDaemonSession not found — Xcode version may be incompatible")
        }
        let selector = NSSelectorFromString("sharedSession")
        let imp = clazz.method(for: selector)
        typealias Method = @convention(c) (AnyClass, Selector) -> NSObject
        let method = unsafeBitCast(imp, to: Method.self)
        let session = method(clazz, selector)

        proxy = session
            .perform(NSSelectorFromString("daemonProxy"))
            .takeUnretainedValue() as! NSObject
    }

    func synthesize(eventRecord: EventRecord) async throws {
        let selector = NSSelectorFromString("_XCT_synthesizeEvent:completion:")
        let imp = proxy.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSObject, @convention(block) @escaping (Error?) -> Void) -> Void
        let method = unsafeBitCast(imp, to: Method.self)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            method(proxy, selector, eventRecord.eventRecord, { error in
                if let error = error {
                    continuation.resume(with: .failure(error))
                } else {
                    continuation.resume(with: .success(()))
                }
            })
        }
    }
}
