import Foundation
import UIKit
import Capacitor
import CryptoKit
import ImageIO
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers

private let nativeUploadChanged = Notification.Name("PrivateArchiveNativeBackgroundUploadChanged")

struct NativeUploadRecord: Codable {
    var id: String
    var batchId: String?
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
    var contentTaskToken: String?
    // Monotonic desired-control generation. Async URLSession task enumeration must
    // verify this before applying pause/resume so an older callback cannot override
    // a newer user action.
    var controlGeneration: Int? = nil
    var ready: Bool
    var createdAt: String
    var updatedAt: String
}

final class NativeBackgroundUploadManager: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDataDelegate {
    static let shared = NativeBackgroundUploadManager()
    static let sessionIdentifier = "cd.cc.joye.photo.background-upload.v1"
    // Builds from the broken reservation generation used a second background session
    // for the tiny /reserve handshake. Keep its identifier only so upgrades can reconnect
    // and retire those legacy tasks; new reservations use the foreground session below.
    static let legacyReserveSessionIdentifier = "cd.cc.joye.photo.background-reserve.v2"

    private let apiBase: URL = {
#if DEBUG
        if let raw = ProcessInfo.processInfo.environment["PRIVATE_ARCHIVE_API_BASE_OVERRIDE"],
           let override = URL(string: raw),
           ["http", "https"].contains(override.scheme?.lowercased() ?? ""),
           override.host != nil {
            return override
        }
#endif
        return URL(string: "https://api.photo.joye.cc.cd")!
    }()
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
    private var stagingHashers: [String: SHA256] = [:]
    private var reserveTasks: [String: URLSessionDataTask] = [:]
    private var lastProgressAt: [String: Date] = [:]
    private var responseBuffers: [String: Data] = [:]
    private var backgroundCompletionHandlers: [String: () -> Void] = [:]
    private var foregroundWatchdogGeneration = 0
    private var reconcileInFlight = false
    private var reconcilePending = false
    private var stagingProtectionDepth = 0
    private var stagingBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    // Keep the system background-transfer queue shallow. Submitting an entire 80-photo
    // batch at once caused iOS to defer the whole group for minutes even though the
    // configuration allowed only three host connections. Records remain durably queued
    // on disk; only this many file tasks are handed to the background daemon at once.
    private let maxActiveUploadPipelines = 3

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

    // /reserve is a short control-plane handshake. The last production generation that
    // demonstrably uploaded originals kept it on a normal URLSession and reserved the
    // background session exclusively for the long-lived file PUT. Moving /reserve onto
    // a second background session introduced a race where a completed reservation could
    // be detached from its in-memory owner, then rotated before /content ever claimed it.
    // Restore that proven boundary: durable bytes stay on disk, and foreground recovery
    // simply repeats this idempotent handshake if the app was suspended before it ended.
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

#if DEBUG
    // iOS Simulator's background-transfer daemon rejects loopback HTTP uploads even
    // though a normal in-app URLSession can reach the same localhost server. The CI
    // protocol smoke therefore swaps only the transport for localhost while preserving
    // the production request builder, task identity, delegate completion, retries and
    // reserve -> content state transition. Release builds cannot compile this override.
    private lazy var protocolSmokeContentSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()
#endif

    // Reconnect the old reserve background session only to cancel tasks left behind by
    // an in-place upgrade. No new request is ever scheduled on this session.
    private lazy var legacyReserveSession: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.legacyReserveSessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()

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
        recoverRetryableFailures()
        _ = session
        _ = legacyReserveSession
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

    private func reserveBodyURL(_ id: String, token: String? = nil) -> URL {
        if let token { return rootDirectory.appendingPathComponent("\(id).\(token).reserve.json") }
        return rootDirectory.appendingPathComponent("\(id).reserve.json")
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
            if fileManager.fileExists(atPath: stateFile.path) {
                _ = try fileManager.replaceItemAt(stateFile, withItemAt: temp)
            } else {
                try fileManager.moveItem(at: temp, to: stateFile)
            }
        } catch {
            try? fileManager.removeItem(at: temp)
        }
    }

    private func recoverInterruptedStaging() {
        var changed = false
        let timestamp = now()
        for (id, var record) in records where !record.ready && record.status != "done" {
            let url = originalURL(id)
            let actualSize = (try? fileSize(url)) ?? -1
            if actualSize == record.sizeBytes, actualSize >= 0,
               let hash = try? sha256(url: url) {
                // The process can be suspended after the final chunk reaches durable
                // storage but before finishJob commits the ready flag. Recover that
                // complete cache automatically instead of forcing the user to reselect.
                record.contentHash = hash
                record.ready = true
                record.status = "retrying"
                record.stage = "reserving"
                record.progress = max(record.progress, 15)
                record.error = "检测到完整本机缓存，正在恢复上传。"
            } else {
                // A partial WebView-to-native copy cannot be reconstructed after the
                // original picker File handle is gone. Keep both the record and partial
                // cache for diagnostics/recovery; only explicit cancel/delete or a
                // successful upload is allowed to release cached bytes.
                record.status = "failed"
                record.stage = "registered"
                record.error = "本机缓存尚未完整写入，请重新选择这个文件。已保留现有缓存。"
            }
            record.updatedAt = timestamp
            records[id] = record
            changed = true
        }
        if changed { saveStateLocked() }
    }

    private func recoverRetryableFailures() {
        var changed = false
        let timestamp = now()
        for (id, var record) in records where record.ready && record.status == "failed" {
            let url = originalURL(id)
            guard fileManager.fileExists(atPath: url.path), (try? fileSize(url)) == record.sizeBytes else { continue }
            // Any failed job with a complete durable original is recoverable. Do not
            // whitelist error strings: server codes evolve, while the local file/hash
            // is the source of truth. Start from a fresh reservation so expired or
            // poisoned upload tokens cannot trap the job in the same failure forever.
            if record.contentHash == nil { record.contentHash = try? sha256(url: url) }
            record.status = "retrying"
            record.stage = "reserving"
            record.progress = min(record.progress, 18)
            record.attempts = 0
            record.remoteAssetId = nil
            record.uploadToken = nil
            record.contentTaskToken = nil
            record.error = "检测到完整本机缓存，正在重新建立后台上传。"
            record.updatedAt = timestamp
            records[id] = record
            changed = true
        }
        if changed { saveStateLocked() }
    }

    func createJob(id: String, batchId: String? = nil, fileName: String, mimeType: String, sizeBytes: Int64, mediaType: String, lastModifiedMs: Double?) throws {
        guard UUID(uuidString: id) != nil, sizeBytes >= 0, ["photo", "video", "file"].contains(mediaType) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 1, userInfo: [NSLocalizedDescriptionKey: "INVALID_JOB"])
        }
        var created: NativeUploadRecord?
        try stateQueue.sync {
            guard records[id] == nil, !fileManager.fileExists(atPath: originalURL(id).path) else {
                throw NSError(domain: "NativeBackgroundUpload", code: 14, userInfo: [NSLocalizedDescriptionKey: "JOB_ALREADY_HAS_LOCAL_CACHE"])
            }
            guard fileManager.createFile(atPath: originalURL(id).path, contents: nil) else {
                throw NSError(domain: "NativeBackgroundUpload", code: 2, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_CREATE_FAILED"])
            }
            let timestamp = now()
            stagingHashers[id] = SHA256()
            let record = NativeUploadRecord(
                id: id, batchId: batchId, fileName: fileName, mimeType: mimeType.isEmpty ? "application/octet-stream" : mimeType,
                sizeBytes: sizeBytes, mediaType: mediaType, lastModifiedMs: lastModifiedMs,
                status: "waiting", stage: "registered", progress: 0, attempts: 0, error: nil,
                remoteAssetId: nil, uploadToken: nil, contentHash: nil, deduplicated: nil, contentTaskToken: nil, ready: false,
                createdAt: timestamp, updatedAt: timestamp
            )
            records[id] = record
            created = record
            saveStateLocked()
        }
        if let created { notify(created) }
    }

    func importPickedPhoto(id: String, batchId: String, sourceURL: URL, fileName: String, mimeType: String, lastModifiedMs: Double?, completion: @escaping (Result<NativeUploadRecord, Error>) -> Void) {
        // loadFileRepresentation only guarantees that sourceURL is valid for the
        // duration of its completion callback. Copy into our app-owned durable cache
        // synchronously before returning from that callback; hashing/reservation can
        // continue asynchronously afterward.
        do {
            let sizeBytes = try fileSize(sourceURL)
            guard sizeBytes >= 0, sizeBytes <= 20 * 1024 * 1024 else {
                throw NSError(domain: "NativeBackgroundUpload", code: 15, userInfo: [NSLocalizedDescriptionKey: "照片超过 Bot 20MB 上传限制。"])
            }
            try createJob(
                id: id, batchId: batchId, fileName: fileName, mimeType: mimeType,
                sizeBytes: sizeBytes, mediaType: "photo", lastModifiedMs: lastModifiedMs
            )
            let destination = originalURL(id)
            try fileManager.removeItem(at: destination)
            try fileManager.copyItem(at: sourceURL, to: destination)
            stateQueue.sync { stagingHashers.removeValue(forKey: id) }
            finishJob(id: id, completion: completion)
        } catch {
            let failed = stateQueue.sync { () -> NativeUploadRecord? in
                guard var record = records[id], record.status != "done" else { return nil }
                record.status = "failed"
                record.error = error.localizedDescription
                record.updatedAt = now()
                records[id] = record
                saveStateLocked()
                return record
            }
            if let failed { notify(failed) }
            completion(.failure(error))
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
            if var hasher = stagingHashers[id] {
                hasher.update(data: data)
                stagingHashers[id] = hasher
            }
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
                let hash = try self.stateQueue.sync { () throws -> String in
                    guard let record = self.records[id] else {
                        throw NSError(domain: "NativeBackgroundUpload", code: 5, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_FOUND"])
                    }
                    let actualSize = try self.fileSize(self.originalURL(id))
                    guard actualSize == record.sizeBytes else {
                        throw NSError(domain: "NativeBackgroundUpload", code: 6, userInfo: [NSLocalizedDescriptionKey: "STAGED_FILE_SIZE_MISMATCH"])
                    }
                    if let hasher = self.stagingHashers.removeValue(forKey: id) {
                        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
                    }
                    // If the WebView or process was briefly interrupted after the last
                    // chunk reached disk, recover by hashing the durable file instead of
                    // turning a complete cached original into an unrecoverable failure.
                    return try self.sha256(url: self.originalURL(id))
                }
                let transition = self.stateQueue.sync { () -> (NativeUploadRecord, Bool)? in
                    guard var value = self.records[id] else { return nil }
                    if value.status == "failed" || value.status == "done" { return (value, false) }
                    value.contentHash = hash
                    value.ready = true
                    value.contentTaskToken = nil
                    value.progress = max(value.progress, 15)
                    let shouldSchedule = value.status != "paused"
                    if shouldSchedule {
                        // Hashing/staging is complete, but do not advertise a network
                        // upload until this record actually owns one of the bounded
                        // reserve/content pipeline slots.
                        value.status = "waiting"
                        value.stage = "reserving"
                        value.error = nil
                    }
                    value.updatedAt = self.now()
                    self.records[id] = value
                    self.saveStateLocked()
                    return (value, shouldSchedule)
                }
                guard let (updated, shouldSchedule) = transition else {
                    throw NSError(domain: "NativeBackgroundUpload", code: 7, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_FOUND"])
                }
                if shouldSchedule { try self.scheduleReserve(updated, earliest: nil) }
                completion(.success(updated))
            } catch {
                if self.nativeUploadErrorCode(error) == 9,
                   let waiting = self.markAwaitingAuthIfActive(id) {
                    self.notify(waiting)
                    completion(.success(waiting))
                    return
                }
                let failed = self.stateQueue.sync { () -> NativeUploadRecord? in
                    guard var value = self.records[id],
                          value.status != "paused", value.status != "done", value.status != "failed" else { return nil }
                    value.status = "failed"
                    value.error = error.localizedDescription
                    value.updatedAt = self.now()
                    self.records[id] = value
                    self.saveStateLocked()
                    return value
                }
                if let failed { self.notify(failed) }
                completion(.failure(error))
            }
        }
    }

    func listJobs() -> [NativeUploadRecord] {
        stateQueue.sync { records.values.sorted { $0.createdAt > $1.createdAt } }
    }

#if DEBUG
    func runNativeProtocolRuntimeSmoke() {
        guard ProcessInfo.processInfo.environment["PRIVATE_ARCHIVE_NATIVE_PROTOCOL_SMOKE"] == "1" else { return }
        guard let host = apiBase.host, host == "127.0.0.1" || host == "localhost" else {
            NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED invalid-api-base=%@", apiBase.absoluteString)
            return
        }
        var cookieProperties: [HTTPCookiePropertyKey: Any] = [
            .name: "pa_account",
            .value: "protocol-smoke-session",
            .domain: host,
            .path: "/",
            .expires: Date().addingTimeInterval(10 * 60),
        ]
        if apiBase.scheme?.lowercased() == "https" { cookieProperties[.secure] = "TRUE" }
        guard let cookie = HTTPCookie(properties: cookieProperties) else {
            NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED cookie-create")
            return
        }
        HTTPCookieStorage.shared.setCookie(cookie)

        let id = UUID().uuidString
        let bytes = Data(repeating: 0x5a, count: 256 * 1024)
        do {
            try createJob(
                id: id,
                batchId: "protocol-smoke",
                fileName: "native-protocol-smoke.bin",
                mimeType: "application/octet-stream",
                sizeBytes: Int64(bytes.count),
                mediaType: "file",
                lastModifiedMs: Date().timeIntervalSince1970 * 1000
            )
            try appendChunk(id: id, data: bytes)
            finishJob(id: id) { result in
                switch result {
                case .success:
                    self.pollNativeProtocolRuntimeSmoke(id: id, remaining: 80)
                case .failure(let error):
                    NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED finish=%@", error.localizedDescription)
                }
            }
        } catch {
            NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED setup=%@", error.localizedDescription)
        }
    }

    private func pollNativeProtocolRuntimeSmoke(id: String, remaining: Int) {
        workerQueue.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self else { return }
            let record = self.stateQueue.sync { self.records[id] }
            if record?.status == "done" {
                NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_COMPLETED id=%@", id)
                self.removeJob(id: id)
                return
            }
            if record?.status == "failed" {
                NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED status=failed stage=%@ error=%@", record?.stage ?? "nil", record?.error ?? "nil")
                return
            }
            guard remaining > 0 else {
                NSLog("PRIVATE_ARCHIVE_PROTOCOL_SMOKE_FAILED timeout status=%@ stage=%@ error=%@", record?.status ?? "nil", record?.stage ?? "nil", record?.error ?? "nil")
                return
            }
            self.pollNativeProtocolRuntimeSmoke(id: id, remaining: remaining - 1)
        }
    }
#endif

    func pauseJob(id: String) {
        let transition = stateQueue.sync { () -> (NativeUploadRecord, Int)? in
            guard var value = records[id], value.status != "done", value.status != "failed" else { return nil }
            let generation = (value.controlGeneration ?? 0) + 1
            value.controlGeneration = generation
            value.status = "paused"
            value.error = "已暂停，后台原件仍安全保存在本机。"
            value.updatedAt = now()
            records[id] = value
            saveStateLocked()
            return (value, generation)
        }
        guard let (paused, generation) = transition else { return }
        notify(paused)
        performOnTasks(id: id, expectedControlGeneration: generation, expectedStatus: "paused", action: { $0.suspend() })
    }

    func resumeJob(id: String, fileName: String?, mimeType: String?, sizeBytes: Int64?, mediaType: String?, contentHash: String?) throws {
        guard UUID(uuidString: id) != nil else {
            throw NSError(domain: "NativeBackgroundUpload", code: 1, userInfo: [NSLocalizedDescriptionKey: "INVALID_JOB"])
        }
        let url = originalURL(id)
        var current = stateQueue.sync(execute: { records[id] })

        // If the durable original survived but jobs.json did not, rebuild the native
        // index from the Web/IndexedDB mirror. This turns "JOB_NOT_FOUND" into an actual
        // cache recovery path instead of abandoning a photo that is still on disk.
        if current == nil {
            guard let fileName, let sizeBytes, let mediaType,
                  sizeBytes >= 0, ["photo", "video", "file"].contains(mediaType),
                  fileManager.fileExists(atPath: url.path), (try? fileSize(url)) == sizeBytes else {
                throw NSError(domain: "NativeBackgroundUpload", code: 5, userInfo: [NSLocalizedDescriptionKey: "JOB_NOT_FOUND_OR_CACHE_INCOMPLETE"])
            }
            let timestamp = now()
            let rebuilt = NativeUploadRecord(
                id: id, batchId: nil, fileName: fileName, mimeType: mimeType?.isEmpty == false ? mimeType! : "application/octet-stream",
                sizeBytes: sizeBytes, mediaType: mediaType, lastModifiedMs: nil,
                status: "failed", stage: "reserving", progress: 15, attempts: 0, error: "已从本机缓存重建上传记录。",
                remoteAssetId: nil, uploadToken: nil, contentHash: contentHash ?? (try? sha256(url: url)), deduplicated: nil, contentTaskToken: nil, ready: true,
                createdAt: timestamp, updatedAt: timestamp
            )
            stateQueue.sync {
                records[id] = rebuilt
                saveStateLocked()
            }
            current = rebuilt
        }

        guard var current, fileManager.fileExists(atPath: url.path) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 13, userInfo: [NSLocalizedDescriptionKey: "本机原件缓存不存在，请重新选择这个文件。"])
        }
        if !current.ready, (try? fileSize(url)) == current.sizeBytes {
            current.contentHash = current.contentHash ?? (try? sha256(url: url))
            current.ready = true
            current.status = "failed"
            current.stage = "reserving"
            current.error = "检测到完整本机缓存，已恢复任务索引。"
            stateQueue.sync {
                records[id] = current
                saveStateLocked()
            }
        }
        guard current.ready, (try? fileSize(url)) == current.sizeBytes else {
            throw NSError(domain: "NativeBackgroundUpload", code: 13, userInfo: [NSLocalizedDescriptionKey: "本机原件未完整保存，请重新选择这个文件。现有部分缓存不会自动删除。"])
        }

        if current.status == "failed" {
            guard let retrying = mutate(id, { value in
                // Manual retry means "recover this cached original", not "replay the
                // same failed token". Force a fresh /reserve against the durable hash.
                value.controlGeneration = (value.controlGeneration ?? 0) + 1
                value.status = "retrying"
                value.stage = "reserving"
                value.progress = min(value.progress, 18)
                value.attempts = 0
                value.remoteAssetId = nil
                value.uploadToken = nil
                value.contentTaskToken = nil
                value.error = "正在从本机缓存重新建立上传。"
            }) else { return }
            let generation = retrying.controlGeneration ?? 0
            notify(retrying)
            let oldReserve = stateQueue.sync { reserveTasks.removeValue(forKey: id) }
            oldReserve?.cancel()
            performOnTasks(id: id, expectedControlGeneration: generation, expectedStatus: "retrying", action: { $0.cancel() }) { _ in
                guard let current = self.stateQueue.sync(execute: { self.records[id] }),
                      (current.controlGeneration ?? 0) == generation, current.status == "retrying" else { return }
                do { try self.scheduleReserve(current, earliest: nil) }
                catch {
                    if let failed = self.markFailedIfActive(id, error: error.localizedDescription) { self.notify(failed) }
                }
            }
            return
        }

        guard let resumed = mutate(id, { value in
            value.controlGeneration = (value.controlGeneration ?? 0) + 1
            value.status = "retrying"
            value.attempts = 0
            value.error = nil
        }) else { return }
        let generation = resumed.controlGeneration ?? 0
        notify(resumed)
        performOnTasks(id: id, expectedControlGeneration: generation, expectedStatus: "retrying", action: { $0.resume() }) { count in
            guard count == 0,
                  let record = self.stateQueue.sync(execute: { self.records[id] }), record.ready,
                  (record.controlGeneration ?? 0) == generation, record.status == "retrying" else { return }
            if record.remoteAssetId != nil, record.uploadToken != nil, record.stage == "original" {
                self.retryContent(record, after: 0, reason: nil)
            } else {
                self.retryReserve(record, after: 0, reason: nil)
            }
        }
    }

    func cancelJob(id: String) {
        let canceled = stateQueue.sync { () -> NativeUploadRecord? in
            guard var value = records[id], value.status != "done" else { return nil }
            stagingHashers.removeValue(forKey: id)
            value.status = "failed"
            value.error = "已取消，本机临时原件已释放。"
            value.contentTaskToken = nil
            value.ready = false
            value.updatedAt = now()
            records[id] = value
            saveStateLocked()
            return value
        }
        guard let canceled else { return }
        let reserve = stateQueue.sync { reserveTasks.removeValue(forKey: id) }
        reserve?.cancel()
        notify(canceled)
        performOnTasks(id: id, action: { $0.cancel() })
        DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
        cleanupFiles(id)
    }

    func removeJob(id: String) {
        let reserve = stateQueue.sync { reserveTasks.removeValue(forKey: id) }
        reserve?.cancel()
        performOnTasks(id: id, action: { $0.cancel() })
        stateQueue.sync {
            stagingHashers.removeValue(forKey: id)
            records.removeValue(forKey: id)
            saveStateLocked()
        }
        DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
        cleanupFiles(id)
    }

    func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == Self.sessionIdentifier || identifier == Self.legacyReserveSessionIdentifier else { return false }
        stateQueue.async { self.backgroundCompletionHandlers[identifier] = completionHandler }
        _ = session
        if identifier == Self.legacyReserveSessionIdentifier { _ = legacyReserveSession }
        reconcileTasks()
        return true
    }

    func resumePendingTransfers() {
        _ = session
        _ = legacyReserveSession
        recoverRetryableFailures()
        reconcileTasks()
    }

    func startForegroundRecoveryWatchdog() {
        let generation = stateQueue.sync { () -> Int in
            foregroundWatchdogGeneration += 1
            return foregroundWatchdogGeneration
        }
        recoverRetryableFailures()
        reconcileTasks()
        scheduleForegroundRecoveryWatchdog(generation: generation)
    }

    func stopForegroundRecoveryWatchdog() {
        stateQueue.sync { foregroundWatchdogGeneration += 1 }
    }

    private func scheduleForegroundRecoveryWatchdog(generation: Int) {
        workerQueue.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self else { return }
            let stillCurrent = self.stateQueue.sync { self.foregroundWatchdogGeneration == generation }
            guard stillCurrent else { return }
            self.reconcileTasks()
            self.scheduleForegroundRecoveryWatchdog(generation: generation)
        }
    }

    func beginStagingProtection() {
        let work = {
            self.stagingProtectionDepth += 1
            guard self.stagingBackgroundTask == .invalid else { return }
            self.stagingBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "PrivateArchiveUploadStaging") { [weak self] in
                guard let self else { return }
                DispatchQueue.main.async {
                    let task = self.stagingBackgroundTask
                    self.stagingBackgroundTask = .invalid
                    if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
                }
            }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
    }

    func endStagingProtection() {
        let work = {
            self.stagingProtectionDepth = max(0, self.stagingProtectionDepth - 1)
            self.endStagingProtectionIfIdleOnMain()
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
    }

    private func endStagingProtectionIfIdleOnMain() {
        guard stagingProtectionDepth == 0, stagingBackgroundTask != .invalid else { return }
        let hasPendingReserve = stateQueue.sync { !reserveTasks.isEmpty }
        guard !hasPendingReserve else { return }
        let task = stagingBackgroundTask
        stagingBackgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
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

    private func markFailedIfActive(_ id: String, error: String) -> NativeUploadRecord? {
        stateQueue.sync {
            guard var record = records[id], record.ready,
                  record.status != "done", record.status != "failed", record.status != "paused" else { return nil }
            record.status = "failed"
            record.error = error
            record.updatedAt = now()
            records[id] = record
            saveStateLocked()
            return record
        }
    }

    private func nativeUploadErrorCode(_ error: Error) -> Int? {
        let value = error as NSError
        guard value.domain == "NativeBackgroundUpload" else { return nil }
        return value.code
    }

    private func markAwaitingAuthIfActive(_ id: String, reason: String = "APP_AUTH_REQUIRED") -> NativeUploadRecord? {
        stateQueue.sync {
            guard var record = records[id], record.ready,
                  record.status != "done", record.status != "paused" else { return nil }
            // A cold/background relaunch can recreate URLSession before the WebView has
            // restored its HttpOnly app cookie. That is not a terminal upload failure:
            // keep the durable original and any valid reservation so foreground auth can
            // resume the exact same transfer instead of creating another server job.
            record.status = "retrying"
            record.error = reason == "APP_AUTH_REQUIRED"
                ? "等待应用登录会话恢复，原件与上传进度已保留。"
                : reason
            record.updatedAt = now()
            records[id] = record
            saveStateLocked()
            return record
        }
    }

    private func restartReservation(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?, cookieOverride: String? = nil) {
        guard let retrying = stateQueue.sync(execute: { () -> NativeUploadRecord? in
            guard var value = records[record.id], value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused" else { return nil }
            value.status = "retrying"
            value.stage = "reserving"
            value.progress = min(value.progress, 18)
            value.remoteAssetId = nil
            value.uploadToken = nil
            value.contentTaskToken = nil
            value.error = reason ?? "正在重新建立上传预约。"
            value.updatedAt = now()
            records[record.id] = value
            saveStateLocked()
            return value
        }) else { return }
        notify(retrying)
        do {
            try scheduleReserve(retrying, earliest: delay > 0 ? Date().addingTimeInterval(delay) : nil, cookieOverride: cookieOverride)
        } catch {
            if nativeUploadErrorCode(error) == 9 {
                if let waiting = markAwaitingAuthIfActive(record.id) { notify(waiting) }
            } else if let failed = markFailedIfActive(record.id, error: error.localizedDescription) {
                notify(failed)
            }
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
        value.removeValue(forKey: "contentTaskToken")
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

    private func activeUploadPipelineCountLocked(excluding id: String? = nil) -> Int {
        var activeIds = Set(reserveTasks.keys)
        for candidate in records.values where candidate.contentTaskToken != nil
            && candidate.status != "done" && candidate.status != "failed" && candidate.status != "paused" {
            activeIds.insert(candidate.id)
        }
        if let id { activeIds.remove(id) }
        return activeIds.count
    }

    private func scheduleReserve(_ record: NativeUploadRecord, earliest: Date?, cookieOverride: String? = nil) throws {
        guard record.ready, fileManager.fileExists(atPath: originalURL(record.id).path) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 8, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_MISSING"])
        }
        if let earliest, earliest > Date() {
            let delay = max(0, earliest.timeIntervalSinceNow)
            workerQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self,
                      let current = self.stateQueue.sync(execute: { self.records[record.id] }),
                      current.ready,
                      current.status != "done", current.status != "failed", current.status != "paused",
                      !(current.stage == "original" && current.remoteAssetId != nil && current.uploadToken != nil) else { return }
                do { try self.scheduleReserve(current, earliest: nil, cookieOverride: cookieOverride) }
                catch {
                    if self.nativeUploadErrorCode(error) == 9 {
                        if let waiting = self.markAwaitingAuthIfActive(record.id) { self.notify(waiting) }
                    } else if let failed = self.markFailedIfActive(record.id, error: error.localizedDescription) {
                        self.notify(failed)
                    }
                }
            }
            return
        }
        guard let cookie = cookieOverride ?? cookieHeader() else {
            throw NSError(domain: "NativeBackgroundUpload", code: 9, userInfo: [NSLocalizedDescriptionKey: "APP_AUTH_REQUIRED"])
        }
        let payload = try reservePayload(record)
        var request = baseRequest(url: apiBase.appendingPathComponent("api/assets/reserve"), method: "POST", cookie: cookie)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(String(payload.count), forHTTPHeaderField: "Content-Length")
        request.httpBody = payload

        var task: URLSessionDataTask!
        task = foregroundSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            let isCurrent = self.stateQueue.sync { () -> Bool in
                guard self.reserveTasks[record.id] === task else { return false }
                self.reserveTasks.removeValue(forKey: record.id)
                return true
            }
            DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
            guard isCurrent,
                  let current = self.stateQueue.sync(execute: { self.records[record.id] }),
                  current.ready, current.status != "done", current.status != "failed", current.status != "paused" else {
                if isCurrent { self.reconcileTasks() }
                return
            }
            defer { self.reconcileTasks() }
            self.handleReserveResult(
                current,
                data: data ?? Data(),
                response: response as? HTTPURLResponse,
                error: error,
                requestCookie: cookie
            )
        }

        var queued: NativeUploadRecord?
        let updated = stateQueue.sync { () -> NativeUploadRecord? in
            guard reserveTasks[record.id] == nil,
                  var value = records[record.id],
                  value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused",
                  !(value.stage == "original" && value.remoteAssetId != nil && value.uploadToken != nil) else { return nil }
            guard activeUploadPipelineCountLocked(excluding: record.id) < maxActiveUploadPipelines else {
                if value.status != "waiting" || value.stage != "reserving" || value.error != nil {
                    value.status = "waiting"
                    value.stage = "reserving"
                    value.error = nil
                    value.updatedAt = now()
                    records[record.id] = value
                    saveStateLocked()
                    queued = value
                }
                return nil
            }
            reserveTasks[record.id] = task
            value.status = value.attempts > 0 ? "retrying" : "uploading"
            value.stage = "reserving"
            value.progress = max(value.progress, 18)
            value.attempts += 1
            value.error = nil
            value.updatedAt = now()
            records[record.id] = value
            saveStateLocked()
            return value
        }
        guard let updated else {
            task.cancel()
            if let queued { notify(queued) }
            return
        }
        notify(updated)
        task.resume()
    }

    private func handleReserveResult(_ record: NativeUploadRecord, data: Data, response: HTTPURLResponse?, error: Error?, requestCookie: String? = nil) {
        guard let current = stateQueue.sync(execute: { records[record.id] }),
              current.ready, current.status != "done", current.status != "failed", current.status != "paused" else { return }
        let record = current
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
                let duplicateAssetId = json["assetId"] as? String
                guard let duplicate = stateQueue.sync(execute: { () -> NativeUploadRecord? in
                    guard var value = records[record.id], value.ready,
                          value.status != "done", value.status != "failed", value.status != "paused",
                          value.stage == "reserving" else { return nil }
                    value.remoteAssetId = duplicateAssetId ?? value.remoteAssetId
                    value.updatedAt = now()
                    records[record.id] = value
                    saveStateLocked()
                    return value
                }) else { return }
                complete(duplicate, deduplicated: true)
                return
            }
            guard let assetId = json["assetId"] as? String, let token = json["uploadToken"] as? String else {
                retryReserve(record, after: 2, reason: "上传预约响应不完整。")
                return
            }
            guard let reserved = stateQueue.sync(execute: { () -> NativeUploadRecord? in
                guard var value = records[record.id], value.ready,
                      value.status != "done", value.status != "failed", value.status != "paused",
                      value.stage == "reserving" else { return nil }
                value.remoteAssetId = assetId
                value.uploadToken = token
                // The reservation capability is already valid at this point. Persist
                // that ownership before creating the content task so a cold-launch auth
                // gap cannot send the same original back through /reserve repeatedly.
                value.stage = "original"
                value.progress = max(value.progress, 28)
                value.updatedAt = now()
                records[record.id] = value
                saveStateLocked()
                return value
            }) else { return }
            do { try scheduleContent(reserved, earliest: nil, cookieOverride: requestCookie) }
            catch {
                if nativeUploadErrorCode(error) == 11 {
                    if let waiting = markAwaitingAuthIfActive(record.id) { notify(waiting) }
                } else {
                    retryContent(reserved, after: 2, reason: error.localizedDescription, consumeAttempt: false, cookieOverride: requestCookie)
                }
            }
            return
        }
        if status == 401 {
            if let waiting = markAwaitingAuthIfActive(record.id, reason: code ?? "APP_AUTH_REQUIRED") { notify(waiting) }
            return
        }
        if status == 403 {
            if let failed = markFailedIfActive(record.id, error: code ?? "APP_UPLOAD_NOT_ALLOWED") { notify(failed) }
            return
        }
        if shouldRetry(status: status, code: code) || status == 0 {
            retryReserve(record, after: retryDelay(response), reason: code, cookieOverride: requestCookie)
            return
        }
        if let failed = markFailedIfActive(record.id, error: code ?? "RESERVATION_FAILED") { notify(failed) }
    }

    private func contentUploadSession() -> URLSession {
#if DEBUG
        if ProcessInfo.processInfo.environment["PRIVATE_ARCHIVE_NATIVE_PROTOCOL_SMOKE"] == "1",
           let host = apiBase.host,
           host == "127.0.0.1" || host == "localhost" {
            return protocolSmokeContentSession
        }
#endif
        return session
    }

    private func scheduleContent(_ record: NativeUploadRecord, earliest: Date?, cookieOverride: String? = nil) throws {
        guard let assetId = record.remoteAssetId, let token = record.uploadToken else {
            throw NSError(domain: "NativeBackgroundUpload", code: 10, userInfo: [NSLocalizedDescriptionKey: "UPLOAD_RESERVATION_MISSING"])
        }
        guard let cookie = cookieOverride ?? cookieHeader() else {
            throw NSError(domain: "NativeBackgroundUpload", code: 11, userInfo: [NSLocalizedDescriptionKey: "APP_AUTH_REQUIRED"])
        }
        guard fileManager.fileExists(atPath: originalURL(record.id).path) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 8, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_MISSING"])
        }
        var request = baseRequest(url: apiBase.appendingPathComponent("api/assets/\(assetId)/content"), method: "PUT", cookie: cookie)
        request.setValue(token, forHTTPHeaderField: "X-Upload-Token")
        request.setValue(record.mimeType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(record.sizeBytes), forHTTPHeaderField: "Content-Length")
        let contentTaskToken = UUID().uuidString
        let delayed = earliest.map { $0 > Date() } ?? false
        var queued: NativeUploadRecord?
        let updated = stateQueue.sync { () -> NativeUploadRecord? in
            guard var value = records[record.id],
                  value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused",
                  value.remoteAssetId == assetId, value.uploadToken == token,
                  value.contentTaskToken == nil else { return nil }
            guard activeUploadPipelineCountLocked(excluding: record.id) < maxActiveUploadPipelines else {
                if value.status != "waiting" || value.stage != "original" || value.error != nil {
                    value.status = "waiting"
                    value.stage = "original"
                    value.progress = max(value.progress, 28)
                    value.error = nil
                    value.updatedAt = now()
                    records[record.id] = value
                    saveStateLocked()
                    queued = value
                }
                return nil
            }
            value.contentTaskToken = contentTaskToken
            value.status = delayed ? "retrying" : "uploading"
            value.stage = "original"
            value.progress = 32
            value.error = delayed ? value.error : nil
            value.updatedAt = now()
            records[record.id] = value
            saveStateLocked()
            return value
        }
        // No slot is not an error. The record already owns a durable reservation and
        // stays in the local queue; the next reserve/content completion fills the slot.
        guard let updated else {
            if let queued { notify(queued) }
            return
        }
        let task = contentUploadSession().uploadTask(with: request, fromFile: originalURL(record.id))
        task.taskDescription = "content|\(record.id)|\(contentTaskToken)"
        task.earliestBeginDate = earliest
        task.priority = URLSessionTask.highPriority
        notify(updated)
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

    private func retryBackoff(_ record: NativeUploadRecord, requested delay: TimeInterval) -> TimeInterval {
        let exponent = min(5, max(0, record.attempts - 1))
        let automatic = min(60.0, 3.0 * pow(2.0, Double(exponent)))
        return max(delay, automatic)
    }

    private func retryReserve(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?, cookieOverride: String? = nil) {
        // A legacy/cold-launch record may still say "reserving" even though the server
        // already returned a valid asset/token. Never create another reservation in that
        // state: normalize it to content ownership and continue the existing transfer.
        if record.remoteAssetId != nil, record.uploadToken != nil {
            let reserved = stateQueue.sync { () -> NativeUploadRecord? in
                guard var value = records[record.id], value.ready,
                      value.status != "done", value.status != "failed", value.status != "paused",
                      value.remoteAssetId != nil, value.uploadToken != nil else { return nil }
                value.stage = "original"
                value.status = "retrying"
                value.error = reason ?? value.error
                value.updatedAt = now()
                records[record.id] = value
                saveStateLocked()
                return value
            }
            if let reserved {
                notify(reserved)
                retryContent(reserved, after: delay, reason: reason, consumeAttempt: false, cookieOverride: cookieOverride)
            }
            return
        }

        let effectiveDelay = retryBackoff(record, requested: delay)
        do {
            try scheduleReserve(record, earliest: effectiveDelay > 0 ? Date().addingTimeInterval(effectiveDelay) : nil, cookieOverride: cookieOverride)
        } catch {
            if nativeUploadErrorCode(error) == 9 {
                if let waiting = markAwaitingAuthIfActive(record.id) { notify(waiting) }
            } else if let failed = markFailedIfActive(record.id, error: error.localizedDescription) {
                notify(failed)
            }
        }
    }

    private func retryContent(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?, consumeAttempt: Bool = true, cookieOverride: String? = nil) {
        guard let assetId = record.remoteAssetId, let uploadToken = record.uploadToken else {
            restartReservation(record, after: delay, reason: reason, cookieOverride: cookieOverride)
            return
        }
        let effectiveDelay = consumeAttempt ? retryBackoff(record, requested: delay) : max(0, delay)
        guard let retrying = stateQueue.sync(execute: { () -> NativeUploadRecord? in
            guard var value = records[record.id], value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused",
                  value.stage == "original",
                  value.remoteAssetId == assetId, value.uploadToken == uploadToken,
                  value.contentTaskToken == nil else { return nil }
            value.status = "retrying"
            value.progress = 32
            if consumeAttempt { value.attempts += 1 }
            value.error = reason ?? "正在重新连接后台上传。"
            value.updatedAt = now()
            records[record.id] = value
            saveStateLocked()
            return value
        }) else { return }
        notify(retrying)

        // Schedule the retry on the background URLSession immediately. A DispatchQueue
        // timer is suspended with the app and was the reason a retry scheduled after a
        // 409/timeout could remain dead until the next foreground launch. earliestBeginDate
        // is owned by the system and survives normal app suspension/termination.
        do {
            try scheduleContent(retrying, earliest: effectiveDelay > 0 ? Date().addingTimeInterval(effectiveDelay) : nil, cookieOverride: cookieOverride)
        } catch {
            switch nativeUploadErrorCode(error) {
            case 11:
                if let waiting = markAwaitingAuthIfActive(record.id) { notify(waiting) }
            case 10:
                restartReservation(retrying, after: 2, reason: error.localizedDescription, cookieOverride: cookieOverride)
            default:
                if let failed = markFailedIfActive(record.id, error: error.localizedDescription) { notify(failed) }
            }
        }
    }

    private func complete(_ record: NativeUploadRecord, deduplicated: Bool) {
        let finished = stateQueue.sync { () -> NativeUploadRecord? in
            guard var value = records[record.id], value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused" else { return nil }
            if !deduplicated {
                guard value.stage == "original",
                      value.remoteAssetId == record.remoteAssetId,
                      value.uploadToken == record.uploadToken else { return nil }
            }
            value.status = "done"
            value.stage = "completed"
            value.progress = 100
            value.error = nil
            value.uploadToken = nil
            value.contentTaskToken = nil
            value.deduplicated = deduplicated
            value.updatedAt = now()
            records[record.id] = value
            saveStateLocked()
            return value
        }
        guard let finished else { return }
        notify(finished)
        cleanupFiles(record.id)
    }

    private func cleanupFiles(_ id: String) {
        stateQueue.sync { lastProgressAt.removeValue(forKey: id) }
        try? fileManager.removeItem(at: originalURL(id))
        try? fileManager.removeItem(at: reserveBodyURL(id))
        if let urls = try? fileManager.contentsOfDirectory(at: rootDirectory, includingPropertiesForKeys: nil) {
            for url in urls where url.lastPathComponent.hasPrefix("\(id).") && url.lastPathComponent.hasSuffix(".reserve.json") {
                try? fileManager.removeItem(at: url)
            }
        }
    }

    private func taskJobId(_ task: URLSessionTask) -> String? {
        guard let description = task.taskDescription else { return nil }
        let parts = description.split(separator: "|", maxSplits: 2).map(String.init)
        return parts.count >= 2 ? parts[1] : nil
    }

    private func taskStage(_ task: URLSessionTask) -> String? {
        task.taskDescription?.split(separator: "|", maxSplits: 2).first.map(String.init)
    }

    private func taskToken(_ task: URLSessionTask) -> String? {
        guard let description = task.taskDescription else { return nil }
        let parts = description.split(separator: "|", maxSplits: 2).map(String.init)
        return parts.count == 3 ? parts[2] : nil
    }

    private func contentRequestMatchesRecord(_ task: URLSessionTask, record: NativeUploadRecord) -> Bool {
        guard record.ready,
              record.stage == "original",
              let assetId = record.remoteAssetId,
              record.uploadToken != nil,
              task.originalRequest?.url?.path == "/api/assets/\(assetId)/content" else { return false }
        // Do not use task.originalRequest custom headers as persisted task identity.
        // Background URLSession may normalize the request it later exposes through
        // getAllTasks/originalRequest. The taskDescription generation token plus the
        // exact asset path is stable across suspension/relaunch; the server remains the
        // authority that validates X-Upload-Token when the request actually arrives.
        return true
    }

    private func contentTaskIdentity(_ task: URLSessionTask) -> String {
        taskToken(task) ?? "legacy:\(task.taskIdentifier)"
    }

    private func taskBufferKey(_ session: URLSession, task: URLSessionTask) -> String {
        "\(session.configuration.identifier ?? "unknown")|\(task.taskIdentifier)"
    }

    private func performOnTasks(
        id: String,
        expectedControlGeneration: Int? = nil,
        expectedStatus: String? = nil,
        action: @escaping (URLSessionTask) -> Void,
        completion: ((Int) -> Void)? = nil
    ) {
        session.getAllTasks { contentTasks in
            let matches = contentTasks.filter { self.taskJobId($0) == id }
            let snapshot = self.stateQueue.sync { () -> (Bool, URLSessionDataTask?) in
                if let expectedControlGeneration {
                    guard let record = self.records[id],
                          (record.controlGeneration ?? 0) == expectedControlGeneration,
                          expectedStatus == nil || record.status == expectedStatus else { return (false, nil) }
                }
                return (true, self.reserveTasks[id])
            }
            if snapshot.0 {
                if let reserve = snapshot.1 { action(reserve) }
                matches.forEach(action)
            }
            if let completion {
                let count = snapshot.0 ? matches.count + (snapshot.1 == nil ? 0 : 1) : 0
                self.workerQueue.async { completion(count) }
            }
        }
    }

    private func reconcileTasks() {
        let shouldStart = stateQueue.sync { () -> Bool in
            if reconcileInFlight {
                reconcilePending = true
                return false
            }
            reconcileInFlight = true
            return true
        }
        guard shouldStart else { return }
        performReconcileTasks()
    }

    private func finishReconcileTasks() {
        let rerun = stateQueue.sync { () -> Bool in
            if reconcilePending {
                reconcilePending = false
                return true
            }
            reconcileInFlight = false
            return false
        }
        if rerun { performReconcileTasks() }
    }

    private func performReconcileTasks() {
        // Capture records before asking URLSession for its task snapshots. This prevents
        // a task created during getAllTasks from being mistaken for an orphan whose
        // persisted owner token should be reclaimed.
        let recordsById = stateQueue.sync { records }
        legacyReserveSession.getAllTasks { legacyReserveTasks in
            // Retire every /reserve task created by the broken dual-background-session
            // generation. A fresh foreground handshake will reclaim its pending asset
            // after the server's stale-reservation window; never let the old callback
            // rotate a newer upload token.
            legacyReserveTasks.forEach { $0.cancel() }

            self.session.getAllTasks { allBackgroundTasks in
                let legacyReserveOnContentSession = allBackgroundTasks.filter { self.taskStage($0) == "reserve" }
                legacyReserveOnContentSession.forEach { $0.cancel() }
                let contentTasks = allBackgroundTasks.filter { self.taskStage($0) == "content" }

                var validContentIds = Set<String>()
                var needsContentRestartIds = Set<String>()
                for task in contentTasks {
                    guard let id = self.taskJobId(task) else {
                        task.cancel()
                        continue
                    }
                    let taskIdentity = self.contentTaskIdentity(task)
                    let ownership = self.stateQueue.sync { () -> (Bool, NativeUploadRecord?) in
                        guard var current = self.records[id], current.ready,
                              current.status != "done", current.status != "failed", current.status != "paused" else { return (false, nil) }
                        guard self.contentRequestMatchesRecord(task, record: current) else {
                            if current.contentTaskToken == taskIdentity {
                                current.contentTaskToken = nil
                                current.updatedAt = self.now()
                                self.records[id] = current
                                self.saveStateLocked()
                            }
                            return (false, current)
                        }
                        if let owner = current.contentTaskToken {
                            return (owner == taskIdentity, current)
                        }
                        current.contentTaskToken = taskIdentity
                        current.updatedAt = self.now()
                        self.records[id] = current
                        self.saveStateLocked()
                        return (true, current)
                    }
                    guard ownership.0, let record = ownership.1 else {
                        if let record = ownership.1,
                           record.stage == "original", record.remoteAssetId != nil, record.uploadToken != nil {
                            needsContentRestartIds.insert(id)
                        }
                        task.cancel()
                        continue
                    }
                    if task.state == .suspended { task.resume() }
                    validContentIds.insert(id)
                }

                // contentTaskToken is persisted so an in-place relaunch can reject
                // duplicate tasks. If iOS discarded the owned task, clear only the
                // generation observed before the task snapshot. A racing new task has a
                // different token and is never reclaimed by this pass.
                self.stateQueue.sync {
                    var changed = false
                    for (id, snapshot) in recordsById where !validContentIds.contains(id) {
                        guard let snapshotToken = snapshot.contentTaskToken,
                              let snapshotUpdatedAt = ISO8601DateFormatter().date(from: snapshot.updatedAt),
                              Date().timeIntervalSince(snapshotUpdatedAt) >= 10,
                              var current = self.records[id],
                              current.contentTaskToken == snapshotToken else { continue }
                        current.contentTaskToken = nil
                        current.updatedAt = self.now()
                        self.records[id] = current
                        changed = true
                    }
                    if changed { self.saveStateLocked() }
                }

                let restartIds = needsContentRestartIds.subtracting(validContentIds)
                let activeReserveIds = self.stateQueue.sync { Set(self.reserveTasks.keys) }
                let activeIds = activeReserveIds.union(validContentIds)
                let resumable = self.stateQueue.sync {
                    self.records.values.filter {
                        $0.ready && $0.status != "done" && $0.status != "failed" && $0.status != "paused" && !activeIds.contains($0.id)
                    }.sorted { $0.createdAt < $1.createdAt }
                }
                for record in resumable {
                    if record.remoteAssetId != nil, record.uploadToken != nil, record.stage == "original" {
                        if restartIds.contains(record.id) {
                            self.retryContent(record, after: 1, reason: "检测到后台上传停滞，正在重新连接。")
                        } else {
                            // A record that simply waited for a bounded pipeline slot is
                            // not a retry and must not consume attempt/backoff budget.
                            do { try self.scheduleContent(record, earliest: nil) }
                            catch {
                                if self.nativeUploadErrorCode(error) == 11 {
                                    if let waiting = self.markAwaitingAuthIfActive(record.id) { self.notify(waiting) }
                                } else if let failed = self.markFailedIfActive(record.id, error: error.localizedDescription) {
                                    self.notify(failed)
                                }
                            }
                        }
                    } else {
                        // Likewise, jobs that have only finished local hashing remain a
                        // FIFO queue until a pipeline slot opens; do not apply retry
                        // backoff to work that has never made a network attempt.
                        do { try self.scheduleReserve(record, earliest: nil) }
                        catch {
                            if self.nativeUploadErrorCode(error) == 9 {
                                if let waiting = self.markAwaitingAuthIfActive(record.id) { self.notify(waiting) }
                            } else if let failed = self.markFailedIfActive(record.id, error: error.localizedDescription) {
                                self.notify(failed)
                            }
                        }
                    }
                }
                self.finishReconcileTasks()
            }
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        responseBuffers[taskBufferKey(session, task: dataTask), default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard taskStage(task) == "content", let id = taskJobId(task), totalBytesExpectedToSend > 0 else { return }
        let taskIdentity = contentTaskIdentity(task)
        let ratio = min(1, max(0, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
        let nextProgress = 32 + ratio * 63
        let updated = stateQueue.sync { () -> NativeUploadRecord? in
            guard var current = records[id],
                  current.status != "done", current.status != "failed", current.status != "paused",
                  current.contentTaskToken == taskIdentity,
                  contentRequestMatchesRecord(task, record: current) else { return nil }
            lastProgressAt[id] = Date()
            guard nextProgress >= 95 || nextProgress - current.progress >= 5 else { return nil }
            current.progress = max(current.progress, nextProgress)
            current.updatedAt = now()
            records[id] = current
            saveStateLocked()
            return current
        }
        if let updated { notify(updated) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let id = taskJobId(task), let stage = taskStage(task) else { return }
        let data = responseBuffers.removeValue(forKey: taskBufferKey(session, task: task)) ?? Data()
        if stage == "reserve" {
            // Delegate-driven reserve tasks can only come from an older installed build.
            // New reservations complete through foregroundSession's closure. Never let a
            // stale background reserve response overwrite/rotate the current capability.
            try? fileManager.removeItem(at: reserveBodyURL(id, token: taskToken(task)))
            return
        }
        let record: NativeUploadRecord?
        if stage == "content" {
            let taskIdentity = contentTaskIdentity(task)
            record = stateQueue.sync { () -> NativeUploadRecord? in
                guard var current = records[id], contentRequestMatchesRecord(task, record: current) else { return nil }
                if let owner = current.contentTaskToken {
                    guard owner == taskIdentity else { return nil }
                } else {
                    // In-place upgrades can inherit a legacy content task whose old
                    // taskDescription had no generation token. Claim that single task
                    // before handling its terminal callback.
                    current.contentTaskToken = taskIdentity
                }
                current.contentTaskToken = nil
                current.updatedAt = now()
                records[id] = current
                saveStateLocked()
                return current
            }
            guard let current = record,
                  current.status != "done", current.status != "failed", current.status != "paused" else { return }
        } else {
            record = stateQueue.sync(execute: { records[id] })
            guard record != nil else { return }
        }
        guard let record else { return }
        let shouldRefillContentWindow = stage == "content"
        // Whichever terminal path this task takes, immediately refill the bounded
        // background-transfer window from the durable local queue.
        defer {
            if shouldRefillContentWindow { reconcileTasks() }
        }
        let response = task.response as? HTTPURLResponse
        // A background task can wake a cold process before the WebView has restored the
        // shared app-session cookie. Reuse the exact Cookie header captured when iOS
        // originally scheduled this task so recovery does not depend on launch ordering.
        let requestCookie = task.originalRequest?.value(forHTTPHeaderField: "Cookie")

        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            if stage == "content" { retryContent(record, after: 5, reason: error.localizedDescription, cookieOverride: requestCookie) }
            else { retryReserve(record, after: 5, reason: error.localizedDescription, cookieOverride: requestCookie) }
            return
        }

        let status = response?.statusCode ?? 0
        let code = responseErrorCode(data)

        if (200...299).contains(status) {
            complete(record, deduplicated: false)
            return
        }
        if status == 401 && code == "APP_AUTH_REQUIRED" {
            if let waiting = markAwaitingAuthIfActive(id) { notify(waiting) }
            return
        }
        if status == 401 {
            // The server validates X-Upload-Token before app auth. A generic content 401
            // therefore means this reservation capability is no longer usable. Clear it
            // explicitly before asking for a fresh reservation; otherwise retryReserve's
            // valid-capability guard would keep replaying the poisoned token forever.
            restartReservation(record, after: retryDelay(response), reason: code ?? "UPLOAD_TOKEN_INVALID_OR_EXPIRED", cookieOverride: requestCookie)
            return
        }
        if status == 409 && code == "UPLOAD_ALREADY_IN_PROGRESS" {
            retryContent(record, after: max(20, retryDelay(response)), reason: code, consumeAttempt: false, cookieOverride: requestCookie)
            return
        }
        if status == 409 && code == "STORAGE_OBJECT_DELETE_IN_PROGRESS" {
            retryContent(record, after: max(20, retryDelay(response)), reason: code, consumeAttempt: false, cookieOverride: requestCookie)
            return
        }
        if status == 409 && code == "STALE_UPLOAD_ATTEMPT" {
            retryContent(record, after: max(5, retryDelay(response)), reason: code, consumeAttempt: false, cookieOverride: requestCookie)
            return
        }
        if shouldRetry(status: status, code: code) || status == 0 {
            retryContent(record, after: retryDelay(response), reason: code, cookieOverride: requestCookie)
            return
        }
        if let failed = markFailedIfActive(id, error: code ?? "STORAGE_UPLOAD_FAILED") { notify(failed) }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let identifier = session.configuration.identifier else { return }
        let completion = stateQueue.sync { backgroundCompletionHandlers.removeValue(forKey: identifier) }
        DispatchQueue.main.async { completion?() }
    }
}

@objc(NativeBackgroundUploadPlugin)
public class NativeBackgroundUploadPlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate {
    public let identifier = "NativeBackgroundUploadPlugin"
    public let jsName = "NativeBackgroundUpload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finishJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginStagingProtection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endStagingProtection", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listJobs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickPhotos", returnType: CAPPluginReturnPromise)
    ]

    private var observer: NSObjectProtocol?
    // Capacitor invokes plugin methods on its background bridge queue. Keep every
    // PhotosUI object and picker lifecycle field confined to the main thread.
    private var photoPickerCall: CAPPluginCall?
    private var photoPickerBatchId: String?
    // Keep provider materialization bounded without parking dozens of GCD worker
    // threads on a semaphore. Large selections previously queued one blocking task per
    // photo (80 selections => 77 blocked workers), which can trigger thread pressure or
    // jetsam on real devices. Two recursive lanes keep at most two provider reads active.
    private let photoImportLaneCount = 2

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

    private func makePhotoPicker() -> PHPickerViewController {
        dispatchPrecondition(condition: .onQueue(.main))
        // PHPicker provides user-selected assets without requiring direct PhotoKit
        // library enumeration. Avoid PHPhotoLibrary.shared() here so opening the picker
        // stays inside the system privacy boundary and does not add a second permission path.
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 0
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        return picker
    }

    private func notifyPickerError(batchId: String, jobId: String?, message: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var data: [String: Any] = ["batchId": batchId, "message": message]
            if let jobId { data["jobId"] = jobId }
            self.notifyListeners("pickerError", data: data, retainUntilConsumed: true)
        }
    }

    @objc func pickPhotos(_ call: CAPPluginCall) {
        guard let batchId = call.getString("batchId"), UUID(uuidString: batchId) != nil else {
            return call.reject("INVALID_BATCH")
        }

        // Capacitor's iOS bridge deliberately performs plugin selectors on a background
        // dispatch queue. PHPickerViewController and its delegate/configuration are
        // MainActor APIs, so constructing them before this hop can terminate the app on
        // a real device even though xcodebuild/analyze succeeds.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.reject("PHOTO_PICKER_UNAVAILABLE") }
            guard self.photoPickerCall == nil else { return call.reject("PHOTO_PICKER_ALREADY_OPEN") }
            guard let viewController = self.bridge?.viewController,
                  viewController.presentedViewController == nil else {
                return call.reject("PHOTO_PICKER_PRESENTATION_BUSY")
            }

            let picker = self.makePhotoPicker()
            self.photoPickerCall = call
            self.photoPickerBatchId = batchId
            viewController.present(picker, animated: true)
        }
    }

    private func startPhotoImportLane(
        _ providers: [NSItemProvider],
        index: Int,
        stride: Int,
        batchId: String,
        group: DispatchGroup
    ) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard index < providers.count else { return }

        let provider = providers[index]
        let jobId = UUID().uuidString
        let typeIdentifier = provider.registeredTypeIdentifiers.first(where: {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .image)
        }) ?? UTType.image.identifier

        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { url, error in
            if let url {
                let type = UTType(typeIdentifier)
                var fileName = provider.suggestedName ?? url.lastPathComponent
                if (fileName as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension {
                    fileName += ".\(ext)"
                }
                let mimeType = type?.preferredMIMEType ?? "image/jpeg"
                let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? nil
                let lastModifiedMs = modified.map { $0.timeIntervalSince1970 * 1000 }

                // loadFileRepresentation only guarantees this URL until its completion
                // handler returns. importPickedPhoto performs the app-owned copy
                // synchronously, then hashes/reserves asynchronously.
                NativeBackgroundUploadManager.shared.importPickedPhoto(
                    id: jobId, batchId: batchId, sourceURL: url, fileName: fileName,
                    mimeType: mimeType, lastModifiedMs: lastModifiedMs
                ) { result in
                    if case .failure(let importError) = result {
                        self.notifyPickerError(batchId: batchId, jobId: jobId, message: importError.localizedDescription)
                    }
                    group.leave()
                }
            } else {
                self.notifyPickerError(
                    batchId: batchId,
                    jobId: jobId,
                    message: error?.localizedDescription ?? "无法读取所选照片。"
                )
                group.leave()
            }

            // Start the next item in this lane only after the temporary provider URL
            // has either been copied or rejected. This keeps provider concurrency
            // strictly bounded without blocking any dispatch worker thread.
            DispatchQueue.main.async {
                self.startPhotoImportLane(providers, index: index + stride, stride: stride, batchId: batchId, group: group)
            }
        }
    }

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        // PHPickerViewControllerDelegate is a MainActor protocol. Keep the retained
        // CAPPluginCall and picker state on that actor as well.
        let call = photoPickerCall
        let batchId = photoPickerBatchId
        photoPickerCall = nil
        photoPickerBatchId = nil
        picker.dismiss(animated: true)
        guard let call, let batchId else { return }
        call.resolve(["batchId": batchId, "count": results.count])
        guard !results.isEmpty else { return }

        NativeBackgroundUploadManager.shared.beginStagingProtection()
        let group = DispatchGroup()
        let providers = results.map(\.itemProvider)
        for _ in providers { group.enter() }
        let lanes = min(photoImportLaneCount, providers.count)
        for lane in 0..<lanes {
            startPhotoImportLane(providers, index: lane, stride: lanes, batchId: batchId, group: group)
        }
        group.notify(queue: .main) {
            NativeBackgroundUploadManager.shared.endStagingProtection()
        }
    }

#if DEBUG
    func runPhotoPickerRuntimeSmoke() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let viewController = self.bridge?.viewController,
                  viewController.presentedViewController == nil else {
                NSLog("PRIVATE_ARCHIVE_PICKER_SMOKE_UNAVAILABLE")
                return
            }
            let picker = self.makePhotoPicker()
            viewController.present(picker, animated: false) {
                NSLog("PRIVATE_ARCHIVE_PICKER_SMOKE_PRESENTED")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    picker.dismiss(animated: false) {
                        NSLog("PRIVATE_ARCHIVE_PICKER_SMOKE_DISMISSED")
                        self.runBulkPhotoImportRuntimeSmoke(count: 80)
                    }
                }
            }
        }
    }

    private func runBulkPhotoImportRuntimeSmoke(count: Int) {
        dispatchPrecondition(condition: .onQueue(.main))
        let batchId = UUID().uuidString
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("PrivateArchiveBulkImportSmoke-\(batchId)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            NSLog("PRIVATE_ARCHIVE_BULK_IMPORT_SMOKE_FAILED create-directory=%@", error.localizedDescription)
            return
        }

        var providers: [NSItemProvider] = []
        providers.reserveCapacity(count)
        for index in 0..<count {
            let url = directory.appendingPathComponent(String(format: "stress-%03d.jpg", index))
            // A small JPEG-shaped payload is enough to exercise NSItemProvider file
            // materialization, app-owned copying, hashing, native state persistence and
            // auth-gated reservation without consuming large simulator memory.
            var bytes = Data([0xff, 0xd8, 0xff, 0xe0])
            bytes.append(Data(repeating: UInt8(index & 0xff), count: 64 * 1024))
            bytes.append(contentsOf: [0xff, 0xd9])
            do {
                try bytes.write(to: url, options: .atomic)
            } catch {
                NSLog("PRIVATE_ARCHIVE_BULK_IMPORT_SMOKE_FAILED write=%@", error.localizedDescription)
                try? FileManager.default.removeItem(at: directory)
                return
            }
            let provider = NSItemProvider()
            provider.suggestedName = url.lastPathComponent
            provider.registerFileRepresentation(forTypeIdentifier: UTType.jpeg.identifier, fileOptions: [], visibility: .all) { completion in
                completion(url, false, nil)
                return nil
            }
            providers.append(provider)
        }

        NativeBackgroundUploadManager.shared.beginStagingProtection()
        let group = DispatchGroup()
        for _ in providers { group.enter() }
        let lanes = min(photoImportLaneCount, providers.count)
        for lane in 0..<lanes {
            startPhotoImportLane(providers, index: lane, stride: lanes, batchId: batchId, group: group)
        }
        group.notify(queue: .main) {
            let jobs = NativeBackgroundUploadManager.shared.listJobs().filter { $0.batchId == batchId }
            let recoverable = jobs.filter { $0.ready && $0.status != "failed" }.count
            NSLog("PRIVATE_ARCHIVE_BULK_IMPORT_SMOKE_COMPLETED count=%d recoverable=%d", jobs.count, recoverable)
            for job in jobs { NativeBackgroundUploadManager.shared.removeJob(id: job.id) }
            try? FileManager.default.removeItem(at: directory)
        }
    }
#endif

    @objc func createJob(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let fileName = call.getString("fileName"),
              let size = call.getInt("sizeBytes"), let mediaType = call.getString("mediaType") else {
            return call.reject("INVALID_JOB")
        }
        do {
            try NativeBackgroundUploadManager.shared.createJob(
                id: id, batchId: call.getString("batchId"), fileName: fileName, mimeType: call.getString("mimeType") ?? "application/octet-stream",
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

    @objc func beginStagingProtection(_ call: CAPPluginCall) {
        NativeBackgroundUploadManager.shared.beginStagingProtection()
        call.resolve()
    }

    @objc func endStagingProtection(_ call: CAPPluginCall) {
        NativeBackgroundUploadManager.shared.endStagingProtection()
        call.resolve()
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
        do {
            try NativeBackgroundUploadManager.shared.resumeJob(
                id: id,
                fileName: call.getString("fileName"),
                mimeType: call.getString("mimeType"),
                sizeBytes: call.getInt("sizeBytes").map { Int64($0) },
                mediaType: call.getString("mediaType"),
                contentHash: call.getString("contentHash")
            )
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
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
        let nativeUploadPlugin = NativeBackgroundUploadPlugin()
        bridge?.registerPluginInstance(nativeUploadPlugin)
#if DEBUG
        // CI launches the simulator with this environment variable to exercise the
        // real PhotosUI construction/presentation path. It is compiled out of Release
        // builds and shares the same makePhotoPicker() implementation used by JS calls.
        if ProcessInfo.processInfo.environment["PRIVATE_ARCHIVE_PICKER_SMOKE"] == "1" {
            nativeUploadPlugin.runPhotoPickerRuntimeSmoke()
        }
#endif
    }
}
