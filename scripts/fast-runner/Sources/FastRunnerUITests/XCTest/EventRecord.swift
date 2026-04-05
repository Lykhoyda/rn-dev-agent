import Foundation
import UIKit

@objc
final class EventRecord: NSObject {
    let eventRecord: NSObject
    static let defaultTapDuration = 0.1

    init(orientation: UIInterfaceOrientation = .portrait) {
        guard let clazz = objc_lookUpClass("XCSynthesizedEventRecord") else {
            fatalError("XCSynthesizedEventRecord not found — Xcode version may be incompatible")
        }
        let alloced = clazz.alloc() as! NSObject
        let selector = NSSelectorFromString("initWithName:interfaceOrientation:")
        let imp = alloced.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSString, Int) -> NSObject
        let method = unsafeBitCast(imp, to: Method.self)
        eventRecord = method(alloced, selector, "Single-Finger Touch Action" as NSString, orientation.rawValue)
    }

    @discardableResult
    func addPointerTouchEvent(at point: CGPoint, touchUpAfter: TimeInterval? = nil) -> Self {
        var path = PointerEventPath.pathForTouch(at: point)
        path.offset += touchUpAfter ?? Self.defaultTapDuration
        path.liftUp()
        return add(path)
    }

    @discardableResult
    func addSwipeEvent(start: CGPoint, end: CGPoint, duration: TimeInterval) -> Self {
        var path = PointerEventPath.pathForTouch(at: start)
        path.offset += duration
        path.moveTo(point: end)
        path.liftUp()
        return add(path)
    }

    @discardableResult
    func add(_ path: PointerEventPath) -> Self {
        let selector = NSSelectorFromString("addPointerEventPath:")
        let imp = eventRecord.method(for: selector)
        typealias Method = @convention(c) (NSObject, Selector, NSObject) -> ()
        let method = unsafeBitCast(imp, to: Method.self)
        method(eventRecord, selector, path.path)
        return self
    }
}
