import Foundation
import Capacitor
import CryptoKit
import ImageIO
import AVFoundation

private let nativeUploadChanged = Notification.Name("PrivateArchiveNativeBackgroundUploadChanged")

struct NativeUploadRecord: Codable {
    var id: String
    var fileName: String
    var mimeType: String
    var sizeBytes: Int64
    var mediaType: String
    var lastModifiedMs: Double?
    var status: String
    var stage: String
    var progress: Double
    var attempts: Int
    var error: String?
    var remoteAssetId: String?
    var uploadToken: String?
    var contentHash: String?
    var deduplicated: Bool?
    var ready: Bool
    var createdAt: String
    var updatedAt: String
}

final class NativeBackgroundUploadManager: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {
    static let shared = NativeBackgroundUploadManager()
    static let sessionIdentifier = "cd.cc.joye.photo.background-upload.v1"

    private let apiBase = URL(string: "https://api.photo.joye.cc.cd")!
    private var fileManager: FileManager { FileManager.default }
    private let stateQueue = DispatchQueue(label: "cd.cc.joye.photo.background-upload.state")
    private let workerQueue = DispatchQueue(label: "cd.cc.joye.photo.background-upload.worker", qos: .utility)
    private let delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.name = "cd.cc.joye.photo.background-upload.delegate"
        queue.maxConcurrentOperationCount = 1
        return queue
    }()
    private var records: [String: NativeUploadRecord] = [:]
    private var responseBuffers: [Int: Data] = [:]
    private var backgroundCompletionHandler: (() -> Void)?

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.httpMaximumConnectionsPerHost = 3
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 180
        configuration.timeoutIntervalForResource = 24 * 60 * 60
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

    // Reservation is a tiny JSON request whose response contains the asset id and
    // upload token needed by the real background transfer. Keeping this handshake
    // on the background URLSession can leave iOS waiting at the reservation boundary
    // even though Cloudflare already created the pending asset. Use a normal session
    // for the sub-second handshake, then hand only the original file to the durable
    // background URLSession.
    private lazy var foregroundSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration)
    }()
    private var reserveTasks: [String: URLSessionDataTask] = [:]

    private lazy var rootDirectory: URL = {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let url = base.appendingPathComponent("PrivateArchiveBackgroundUploads", isDirectory: true)
        try? fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var stateFile: URL { rootDirectory.appendingPathComponent("jobs.json") }

    private override init() {
        super.init()
        _ = rootDirectory
        loadState()
        recoverInterruptedStaging()
        _ = session
        reconcileTasks()
    }

    private func now() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func fileSize(_ url: URL) throws -> Int64 {
        let attributes = try fileManager.attributesOfItem(atPath: url.path)
        return (attributes[.size] as? NSNumber)?.int64Value ?? -1
    }

    private func originalURL(_ id: String) -> URL {
        rootDirectory.appendingPathComponent("\(id).upload")
    }

    private func reserveBodyURL(_ id: String) -> URL {
        rootDirectory.appendingPathComponent("\(id).reserve.json")
    }

    private func loadState() {
        guard let data = try? Data(contentsOf: stateFile),
              let decoded = try? JSONDecoder().decode([String: NativeUploadRecord].self, from: data) else { return }
        records = decoded
    }

    private func saveStateLocked() {
        guard let data = try? JSONEncoder().encode(records) else { return }
        let temp = stateFile.appendingPathExtension("tmp")
        do {
            try data.write(to: temp, options: .atomic)
            if fileManager.fileExists(atPath: stateFile.path) { try fileManager.removeItem(at: stateFile) }
            try fileManager.moveItem(at: temp, to: stateFile)
        } catch {
            try? fileManager.removeItem(at: temp)
        }
    }

    private func recoverInterruptedStaging() {
        var changed: [NativeUploadRecord] = []
        let timestamp = now()
        for (id, var record) in records where !record.ready && record.status != "done" {
            record.status = "failed"
            record.stage = "registered"
            record.error = "本机保存被中断，请重新选择这个文件。"
            record.updatedAt = timestamp
            records[id] = record
            changed.append(record)
            try? fileManager.removeItem(at: originalURL(id))
        }
        if !changed.isEmpty { saveStateLocked() }
    }

    func createJob(id: String, fileName: String, mimeType: String, sizeBytes: Int64, mediaType: String, lastModifiedMs: Double?) throws {
        guard !id.isEmpty, sizeBytes >= 0, ["photo", "video", "file"].contains(mediaType) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 1, userInfo: [NSLocalizedDescriptionKey: "INVALID_JOB"])
        }
        try stateQueue.sync {
            try? fileManager.removeItem(at: originalURL(id))
            guard fileManager.createFile(atPath: originalURL(id).path, contents: nil) else {
                throw NSError(domain: "NativeBackgroundUpload", code: 2, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_CREATE_FAILED"])
            }
            let timestamp = now()
            records[id] = NativeUploadRecord(
                id: id, fileName: fileName, mimeType: mimeType.isEmpty ? "application/octet-stream" : mimeType,
                sizeBytes: sizeBytes, mediaType: mediaType, lastModifiedMs: lastModifiedMs,
                status: "waiting", stage: "registered", progress: 0, attempts: 0, error: nil,
                remoteAssetId: nil, uploadToken: nil, contentHash: nil, deduplicated: nil, ready: false,
                createdAt: timestamp, updatedAt: timestamp
            )
            saveStateLocked()
        }
    }

    func appendChunk(id: String, data: Data) throws {
        try stateQueue.sync {
            guard var record = records[id], !record.ready else {
                throw NSError(domain: "NativeBackgroundUpload", code: 3, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_STAGING"])
            }
            let url = originalURL(id)
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            handle.seekToEndOfFile()
            handle.write(data)
            let currentSize = (try? fileSize(url)) ?? 0
            if currentSize > record.sizeBytes {
                throw NSError(domain: "NativeBackgroundUpload", code: 4, userInfo: [NSLocalizedDescriptionKey: "STAGED_FILE_TOO_LARGE"])
            }
            record.progress = record.sizeBytes > 0 ? min(10, Double(currentSize) / Double(record.sizeBytes) * 10) : 10
            record.updatedAt = now()
            records[id] = record
            // A staging job is deliberately unrecoverable until finishJob marks it ready.
            // Persisting jobs.json for every bridge chunk only adds synchronous disk I/O
            // and makes multi-photo imports visibly stall. createJob already persisted the
            // not-ready record; a process interruption will therefore still be recovered
            // as an interrupted staging job on the next launch.
        }
    }

    func finishJob(id: String, completion: @escaping (Result<NativeUploadRecord, Error>) -> Void) {
        workerQueue.async {
            do {
                let record = try self.stateQueue.sync { () throws -> NativeUploadRecord in
                    guard let record = self.records[id] else {
                        throw NSError(domain: "NativeBackgroundUpload", code: 5, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_FOUND"])
                    }
                    let actualSize = try self.fileSize(self.originalURL(id))
                    guard actualSize == record.sizeBytes else {
                        throw NSError(domain: "NativeBackgroundUpload", code: 6, userInfo: [NSLocalizedDescriptionKey: "STAGED_FILE_SIZE_MISMATCH"])
                    }
                    return record
                }
                let hash = try self.sha256(url: self.originalURL(id))
                let updated = self.mutate(id) { value in
                    value.contentHash = hash
                    value.ready = true
                    value.status = "uploading"
                    value.stage = "reserving"
                    value.progress = max(value.progress, 15)
                    value.error = nil
                }
                guard let updated else { throw NSError(domain: "NativeBackgroundUpload", code: 7, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_FOUND"]) }
                try self.scheduleReserve(updated, earliest: nil)
                completion(.success(updated))
                _ = record
            } catch {
                let failed = self.mutate(id) { value in
                    value.status = "failed"
                    value.error = error.localizedDescription
                }
                if let failed { self.notify(failed) }
                completion(.failure(error))
            }
        }
    }

    func listJobs() -> [NativeUploadRecord] {
        stateQueue.sync { records.values.sorted { $0.createdAt > $1.createdAt } }
    }

    func pauseJob(id: String) {
        session.getAllTasks { tasks in
            tasks.filter { self.taskJobId($0) == id }.forEach { $0.suspend() }
        }
        stateQueue.sync { reserveTasks[id]?.suspend() }
        if let record = mutate(id, { value in
            value.status = "paused"
            value.error = "已暂停，后台原件仍安全保存在本机。"
        }) { notify(record) }
    }

    func resumeJob(id: String) {
        if let reserveTask = stateQueue.sync(execute: { reserveTasks[id] }) {
            reserveTask.resume()
            if let record = mutate(id, { value in value.status = "retrying"; value.error = nil }) { notify(record) }
            return
        }
        session.getAllTasks { tasks in
            let matches = tasks.filter { self.taskJobId($0) == id }
            if !matches.isEmpty {
                matches.forEach { $0.resume() }
                if let record = self.mutate(id, { value in
                    value.status = "retrying"
                    value.error = nil
                }) { self.notify(record) }
                return
            }
            guard let record = self.stateQueue.sync(execute: { self.records[id] }), record.ready else { return }
            if record.remoteAssetId != nil, record.uploadToken != nil, record.stage == "original" {
                self.retryContent(record, after: 0, reason: nil)
            } else {
                self.retryReserve(record, after: 0, reason: nil)
            }
        }
    }

    func cancelJob(id: String) {
        session.getAllTasks { tasks in
            tasks.filter { self.taskJobId($0) == id }.forEach { $0.cancel() }
        }
        stateQueue.sync { reserveTasks.removeValue(forKey: id)?.cancel() }
        if let record = mutate(id, { value in
            value.status = "failed"
            value.error = "已取消，本机临时原件已释放。"
            value.ready = false
        }) { notify(record) }
        cleanupFiles(id)
    }

    func removeJob(id: String) {
        session.getAllTasks { tasks in
            tasks.filter { self.taskJobId($0) == id }.forEach { $0.cancel() }
        }
        stateQueue.sync {
            reserveTasks.removeValue(forKey: id)?.cancel()
            records.removeValue(forKey: id)
            saveStateLocked()
        }
        cleanupFiles(id)
    }

    func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == Self.sessionIdentifier else { return false }
        stateQueue.async { self.backgroundCompletionHandler = completionHandler }
        _ = session
        return true
    }

    private func mutate(_ id: String, _ body: (inout NativeUploadRecord) -> Void) -> NativeUploadRecord? {
        stateQueue.sync {
            guard var record = records[id] else { return nil }
            body(&record)
            record.updatedAt = now()
            records[id] = record
            saveStateLocked()
            return record
        }
    }

    private func dictionary(_ record: NativeUploadRecord) -> [String: Any] {
        guard let data = try? JSONEncoder().encode(record),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    func publicDictionary(_ record: NativeUploadRecord) -> [String: Any] {
        var value = dictionary(record)
        value.removeValue(forKey: "uploadToken")
        value.removeValue(forKey: "contentHash")
        value.removeValue(forKey: "ready")
        value.removeValue(forKey: "lastModifiedMs")
        return value
    }

    private func notify(_ record: NativeUploadRecord) {
        let payload = publicDictionary(record)
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: nativeUploadChanged, object: nil, userInfo: ["job": payload])
        }
    }

    private func cookieHeader() -> String? {
        guard let cookies = HTTPCookieStorage.shared.cookies(for: apiBase), !cookies.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
    }

    private func baseRequest(url: URL, method: String, cookie: String) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
        request.setValue("ios", forHTTPHeaderField: "X-Private-Archive-Native")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        return request
    }

    private func scheduleReserve(_ record: NativeUploadRecord, earliest: Date?) throws {
        guard record.ready, fileManager.fileExists(atPath: originalURL(record.id).path) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 8, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_MISSING"])
        }
        if let earliest, earliest > Date() {
            let delay = earliest.timeIntervalSinceNow
            workerQueue.asyncAfter(deadline: .now() + max(0, delay)) { [weak self] in
                guard let self,
                      let current = self.stateQueue.sync(execute: { self.records[record.id] }),
                      current.ready,
                      current.status != "done",
                      current.status != "failed",
                      current.status != "paused" else { return }
                do { try self.scheduleReserve(current, earliest: nil) }
                catch {
                    if let failed = self.mutate(record.id, { value in value.status = "failed"; value.error = error.localizedDescription }) {
                        self.notify(failed)
                    }
                }
            }
            return
        }
        guard let cookie = cookieHeader() else {
            throw NSError(domain: "NativeBackgroundUpload", code: 9, userInfo: [NSLocalizedDescriptionKey: "APP_AUTH_REQUIRED"])
        }
        let payload = try reservePayload(record)
        var request = baseRequest(url: apiBase.appendingPathComponent("api/assets/reserve"), method: "POST", cookie: cookie)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(String(payload.count), forHTTPHeaderField: "Content-Length")
        request.httpBody = payload

        let task = foregroundSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            _ = self.stateQueue.sync { self.reserveTasks.removeValue(forKey: record.id) }
            guard let current = self.stateQueue.sync(execute: { self.records[record.id] }), current.ready else { return }
            self.handleReserveResult(current, data: data ?? Data(), response: response as? HTTPURLResponse, error: error)
        }
        let shouldStart = stateQueue.sync { () -> Bool in
            guard reserveTasks[record.id] == nil else { return false }
            reserveTasks[record.id] = task
            return true
        }
        guard shouldStart else { return }
        let updated = mutate(record.id) { value in
            value.status = value.attempts > 0 ? "retrying" : "uploading"
            value.stage = "reserving"
            value.progress = max(value.progress, 18)
            value.attempts += 1
            value.error = nil
        }
        if let updated { notify(updated) }
        task.resume()
    }

    private func handleReserveResult(_ record: NativeUploadRecord, data: Data, response: HTTPURLResponse?, error: Error?) {
        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            retryReserve(record, after: 3, reason: error.localizedDescription)
            return
        }
        let status = response?.statusCode ?? 0
        let code = responseErrorCode(data)
        if (200...299).contains(status), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if json["duplicate"] as? Bool == true {
                if let assetId = json["assetId"] as? String { _ = mutate(record.id) { $0.remoteAssetId = assetId } }
                complete(record, deduplicated: true)
                return
            }
            guard let assetId = json["assetId"] as? String, let token = json["uploadToken"] as? String else {
                retryReserve(record, after: 2, reason: "上传预约响应不完整。")
                return
            }
            guard let reserved = mutate(record.id, { value in
                value.remoteAssetId = assetId
                value.uploadToken = token
                value.progress = max(value.progress, 28)
            }) else { return }
            do { try scheduleContent(reserved, earliest: nil) }
            catch { retryReserve(reserved, after: 2, reason: error.localizedDescription) }
            return
        }
        if status == 401 || status == 403 {
            if let failed = mutate(record.id, { value in value.status = "failed"; value.error = code ?? "APP_AUTH_REQUIRED" }) { notify(failed) }
            return
        }
        if shouldRetry(status: status, code: code) || status == 0 {
            retryReserve(record, after: retryDelay(response), reason: code)
            return
        }
        if let failed = mutate(record.id, { value in value.status = "failed"; value.error = code ?? "RESERVATION_FAILED" }) { notify(failed) }
    }

    private func scheduleContent(_ record: NativeUploadRecord, earliest: Date?) throws {
        guard let assetId = record.remoteAssetId, let token = record.uploadToken else {
            throw NSError(domain: "NativeBackgroundUpload", code: 10, userInfo: [NSLocalizedDescriptionKey: "UPLOAD_RESERVATION_MISSING"])
        }
        guard let cookie = cookieHeader() else {
            throw NSError(domain: "NativeBackgroundUpload", code: 11, userInfo: [NSLocalizedDescriptionKey: "APP_AUTH_REQUIRED"])
        }
        var request = baseRequest(url: apiBase.appendingPathComponent("api/assets/\(assetId)/content"), method: "PUT", cookie: cookie)
        request.setValue(token, forHTTPHeaderField: "X-Upload-Token")
        request.setValue(record.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(record.sizeBytes), forHTTPHeaderField: "Content-Length")
        let task = session.uploadTask(with: request, fromFile: originalURL(record.id))
        task.taskDescription = "content|\(record.id)"
        task.earliestBeginDate = earliest
        if let updated = mutate(record.id, { value in
            value.status = "uploading"
            value.stage = "original"
            value.progress = max(value.progress, 32)
            value.error = nil
        }) { notify(updated) }
        task.resume()
    }

    private func reservePayload(_ record: NativeUploadRecord) throws -> Data {
        var body: [String: Any] = [
            "originalName": record.fileName,
            "mimeType": record.mimeType,
            "sizeBytes": record.sizeBytes,
            "mediaType": record.mediaType,
            "storageBackend": "telegram_bot",
            "importOrigin": "ios-background"
        ]
        if let contentHash = record.contentHash { body["contentHash"] = contentHash }
        if let modified = record.lastModifiedMs, modified > 0 {
            body["fileCreatedAt"] = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: modified / 1000))
        }
        var metadata: [String: Any] = ["nativeBackgroundUpload": true]
        if record.mediaType == "photo" {
            mergeImageMetadata(url: originalURL(record.id), into: &body, metadata: &metadata)
        } else if record.mediaType == "video" {
            mergeVideoMetadata(url: originalURL(record.id), into: &body)
        }
        body["metadata"] = metadata
        return try JSONSerialization.data(withJSONObject: body)
    }

    private func mergeImageMetadata(url: URL, into body: inout [String: Any], metadata: inout [String: Any]) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return }
        if let width = properties[kCGImagePropertyPixelWidth] as? NSNumber { body["width"] = width.doubleValue }
        if let height = properties[kCGImagePropertyPixelHeight] as? NSNumber { body["height"] = height.doubleValue }
        if let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
            if let make = tiff[kCGImagePropertyTIFFMake] as? String { metadata["cameraMake"] = make }
            if let model = tiff[kCGImagePropertyTIFFModel] as? String { metadata["cameraModel"] = model }
        }
        if let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            if let raw = exif[kCGImagePropertyExifDateTimeOriginal] as? String, let date = parseExifDate(raw) {
                body["takenAt"] = ISO8601DateFormatter().string(from: date)
            }
            if let lens = exif[kCGImagePropertyExifLensModel] as? String { metadata["lensModel"] = lens }
            if let iso = (exif[kCGImagePropertyExifISOSpeedRatings] as? [NSNumber])?.first { metadata["iso"] = iso.doubleValue }
            if let exposure = exif[kCGImagePropertyExifExposureTime] as? NSNumber { metadata["exposureTime"] = exposure.doubleValue }
            if let aperture = exif[kCGImagePropertyExifFNumber] as? NSNumber { metadata["fNumber"] = aperture.doubleValue }
            if let focal = exif[kCGImagePropertyExifFocalLength] as? NSNumber { metadata["focalLength"] = focal.doubleValue }
        }
        if let gps = properties[kCGImagePropertyGPSDictionary] as? [CFString: Any] {
            if let latitude = gpsCoordinate(gps[kCGImagePropertyGPSLatitude], ref: gps[kCGImagePropertyGPSLatitudeRef] as? String, negativeRef: "S") {
                body["latitude"] = latitude
            }
            if let longitude = gpsCoordinate(gps[kCGImagePropertyGPSLongitude], ref: gps[kCGImagePropertyGPSLongitudeRef] as? String, negativeRef: "W") {
                body["longitude"] = longitude
            }
        }
    }

    private func mergeVideoMetadata(url: URL, into body: inout [String: Any]) {
        let asset = AVURLAsset(url: url)
        let duration = CMTimeGetSeconds(asset.duration)
        if duration.isFinite && duration >= 0 { body["durationMs"] = duration * 1000 }
        if let track = asset.tracks(withMediaType: .video).first {
            let transformed = track.naturalSize.applying(track.preferredTransform)
            let width = abs(transformed.width)
            let height = abs(transformed.height)
            if width > 0 { body["width"] = Double(width) }
            if height > 0 { body["height"] = Double(height) }
        }
    }

    private func parseExifDate(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy:MM:dd HH:mm:ss"
        formatter.timeZone = TimeZone.current
        return formatter.date(from: value)
    }

    private func gpsCoordinate(_ value: Any?, ref: String?, negativeRef: String) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        let absolute = abs(number.doubleValue)
        return ref?.uppercased() == negativeRef ? -absolute : absolute
    }

    private func sha256(url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func retryDelay(_ response: HTTPURLResponse?) -> TimeInterval {
        if let raw = response?.value(forHTTPHeaderField: "Retry-After"), let seconds = TimeInterval(raw), seconds > 0 {
            return min(max(seconds, 1), 15 * 60)
        }
        return 5
    }

    private func responseErrorCode(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["error"] as? String
    }

    private func shouldRetry(status: Int, code: String?) -> Bool {
        if [408, 409, 425, 429, 500, 502, 503, 504].contains(status) { return true }
        return code == "DUPLICATE_UPLOAD_IN_PROGRESS" || code == "UPLOAD_ALREADY_IN_PROGRESS"
    }

    private func retryReserve(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?) {
        guard record.attempts < 24 else {
            if let failed = mutate(record.id, { value in value.status = "failed"; value.error = reason ?? "后台上传重试次数过多。" }) { notify(failed) }
            return
        }
        do { try scheduleReserve(record, earliest: Date().addingTimeInterval(delay)) }
        catch {
            if let failed = mutate(record.id, { value in value.status = "failed"; value.error = error.localizedDescription }) { notify(failed) }
        }
    }

    private func retryContent(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?) {
        guard record.remoteAssetId != nil, record.uploadToken != nil else {
            retryReserve(record, after: delay, reason: reason)
            return
        }
        workerQueue.asyncAfter(deadline: .now() + max(0, delay)) { [weak self] in
            guard let self,
                  let current = self.stateQueue.sync(execute: { self.records[record.id] }),
                  current.ready,
                  current.status != "done",
                  current.status != "failed",
                  current.status != "paused" else { return }
            do { try self.scheduleContent(current, earliest: nil) }
            catch { self.retryReserve(current, after: 2, reason: error.localizedDescription) }
        }
    }

    private func complete(_ record: NativeUploadRecord, deduplicated: Bool) {
        if let finished = mutate(record.id, { value in
            value.status = "done"
            value.stage = "completed"
            value.progress = 100
            value.error = nil
            value.uploadToken = nil
            value.deduplicated = deduplicated
        }) { notify(finished) }
        cleanupFiles(record.id)
    }

    private func cleanupFiles(_ id: String) {
        try? fileManager.removeItem(at: originalURL(id))
        try? fileManager.removeItem(at: reserveBodyURL(id))
    }

    private func taskJobId(_ task: URLSessionTask) -> String? {
        guard let description = task.taskDescription else { return nil }
        let parts = description.split(separator: "|", maxSplits: 1).map(String.init)
        return parts.count == 2 ? parts[1] : nil
    }

    private func taskStage(_ task: URLSessionTask) -> String? {
        task.taskDescription?.split(separator: "|", maxSplits: 1).first.map(String.init)
    }

    private func reconcileTasks() {
        session.getAllTasks { tasks in
            // Older builds used the background session for the tiny /reserve request.
            // A task from that implementation can survive an in-place app update and
            // remain parked at 18%, which would make its job look active forever and
            // prevent the new foreground reservation path from taking over. Cancel
            // only those legacy reserve tasks; keep real content uploads attached.
            let legacyReserveTasks = tasks.filter { self.taskStage($0) == "reserve" }
            legacyReserveTasks.forEach { $0.cancel() }
            let activeIds = Set(tasks.filter { self.taskStage($0) != "reserve" }.compactMap { self.taskJobId($0) })
            let resumable = self.stateQueue.sync {
                self.records.values.filter { $0.ready && $0.status != "done" && $0.status != "failed" && !activeIds.contains($0.id) }
            }
            for record in resumable {
                if record.remoteAssetId != nil, record.uploadToken != nil, record.stage == "original" {
                    self.retryContent(record, after: 0, reason: nil)
                } else {
                    self.retryReserve(record, after: 0, reason: nil)
                }
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responseBuffers[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard taskStage(task) == "content", let id = taskJobId(task), totalBytesExpectedToSend > 0 else { return }
        let ratio = min(1, max(0, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
        if let record = mutate(id, { value in value.progress = max(value.progress, 32 + ratio * 63) }) { notify(record) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = taskJobId(task), let stage = taskStage(task) else { return }
        let data = responseBuffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let record = stateQueue.sync(execute: { records[id] }) else { return }
        let response = task.response as? HTTPURLResponse

        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if stage == "content" { retryContent(record, after: 5, reason: error.localizedDescription) }
            else { retryReserve(record, after: 5, reason: error.localizedDescription) }
            return
        }

        let status = response?.statusCode ?? 0
        let code = responseErrorCode(data)
        if stage == "reserve" {
            // Compatibility for reservation tasks created by older app builds. New
            // builds perform this tiny handshake on foregroundSession and reserve the
            // background URLSession exclusively for the original file transfer.
            handleReserveResult(record, data: data, response: response, error: nil)
            return
        }

        if (200...299).contains(status) {
            complete(record, deduplicated: false)
            return
        }
        if status == 401 && code == "APP_AUTH_REQUIRED" {
            if let failed = mutate(id, { value in value.status = "failed"; value.error = code }) { notify(failed) }
            return
        }
        if status == 401 {
            retryReserve(record, after: retryDelay(response), reason: code)
            return
        }
        if shouldRetry(status: status, code: code) || status == 0 {
            retryContent(record, after: retryDelay(response), reason: code)
            return
        }
        if let failed = mutate(id, { value in value.status = "failed"; value.error = code ?? "STORAGE_UPLOAD_FAILED" }) { notify(failed) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = stateQueue.sync { () -> (() -> Void)? in
            let value = backgroundCompletionHandler
            backgroundCompletionHandler = nil
            return value
        }
        DispatchQueue.main.async { completion?() }
    }
}

@objc(NativeBackgroundUploadPlugin)
public class NativeBackgroundUploadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeBackgroundUploadPlugin"
    public let jsName = "NativeBackgroundUpload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listJobs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeJob", returnType: CAPPluginReturnPromise)
    ]

    private var observer: NSObjectProtocol?

    @objc override public func load() {
        _ = NativeBackgroundUploadManager.shared
        observer = NotificationCenter.default.addObserver(forName: nativeUploadChanged, object: nil, queue: .main) { [weak self] notification in
            guard let job = notification.userInfo?["job"] as? [String: Any] else { return }
            self?.notifyListeners("stateChanged", data: ["job": job], retainUntilConsumed: true)
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func createJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let fileName = call.getString("fileName"),
              let size = call.getInt("sizeBytes"), let mediaType = call.getString("mediaType") else {
            return call.reject("INVALID_JOB")
        }
        do {
            try NativeBackgroundUploadManager.shared.createJob(
                id: id, fileName: fileName, mimeType: call.getString("mimeType") ?? "application/octet-stream",
                sizeBytes: Int64(size), mediaType: mediaType, lastModifiedMs: call.getDouble("lastModifiedMs")
            )
            call.resolve()
        } catch { call.reject(error.localizedDescription) }
    }

    @objc func appendChunk(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let base64 = call.getString("base64"), let data = Data(base64Encoded: base64) else {
            return call.reject("INVALID_CHUNK")
        }
        do { try NativeBackgroundUploadManager.shared.appendChunk(id: id, data: data); call.resolve() }
        catch { call.reject(error.localizedDescription) }
    }

    @objc func finishJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("INVALID_JOB") }
        NativeBackgroundUploadManager.shared.finishJob(id: id) { result in
            switch result {
            case .success(let job): call.resolve(["job": NativeBackgroundUploadManager.shared.publicDictionary(job)])
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }

    @objc func listJobs(_ call: CAPPluginCall) {
        call.resolve(["items": NativeBackgroundUploadManager.shared.listJobs().map { NativeBackgroundUploadManager.shared.publicDictionary($0) }])
    }

    @objc func pauseJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("INVALID_JOB") }
        NativeBackgroundUploadManager.shared.pauseJob(id: id)
        call.resolve()
    }

    @objc func resumeJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("INVALID_JOB") }
        NativeBackgroundUploadManager.shared.resumeJob(id: id)
        call.resolve()
    }

    @objc func cancelJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("INVALID_JOB") }
        NativeBackgroundUploadManager.shared.cancelJob(id: id)
        call.resolve()
    }

    @objc func removeJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { return call.reject("INVALID_JOB") }
        NativeBackgroundUploadManager.shared.removeJob(id: id)
        call.resolve()
    }
}

class PrivateArchiveBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Capacitor 8 enables automatic plugin registration by default. In that mode
        // registerPluginType(_:) intentionally returns without doing anything, which
        // made the JS bridge report “NativeBackgroundUpload plugin is not implemented
        // on ios”. Instance registration is the supported runtime path for this local,
        // app-owned plugin and works regardless of automatic package-plugin discovery.
        bridge?.registerPluginInstance(NativeBackgroundUploadPlugin())
    }
}
