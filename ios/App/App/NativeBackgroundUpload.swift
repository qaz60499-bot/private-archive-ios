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
    static let reserveSessionIdentifier = "cd.cc.joye.photo.background-reserve.v2"

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
    private var stagingHashers: [String: SHA256] = [:]
    private var reserveTaskTokens: [String: String] = [:]
    private var lastProgressAt: [String: Date] = [:]
    private var responseBuffers: [String: Data] = [:]
    private var backgroundCompletionHandlers: [String: () -> Void] = [:]
    private var foregroundWatchdogGeneration = 0
    private var reconcileInFlight = false
    private var reconcilePending = false
    private var stagingProtectionDepth = 0
    private var stagingBackgroundTask: UIBackgroundTaskIdentifier = .invalid

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

    // Keep reservation handshakes on a dedicated background session. This avoids
    // queueing tiny /reserve requests behind large file transfers while still letting
    // iOS finish the handshake after the app is suspended. The previous foreground
    // session was the main reason a fully cached photo could remain stuck forever when
    // the user switched apps before its reservation returned.
    private lazy var reserveSession: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.reserveSessionIdentifier)
        configuration.sessionSendsLaunchEvents = true
        configuration.isDiscretionary = false
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = true
        configuration.httpMaximumConnectionsPerHost = 6
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 15 * 60
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
        _ = reserveSession
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
                        value.status = "uploading"
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
            stateQueue.sync { reserveTaskTokens.removeValue(forKey: id) }
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
            reserveTaskTokens.removeValue(forKey: id)
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
        notify(canceled)
        performOnTasks(id: id, action: { $0.cancel() })
        DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
        cleanupFiles(id)
    }

    func removeJob(id: String) {
        performOnTasks(id: id, action: { $0.cancel() })
        stateQueue.sync {
            stagingHashers.removeValue(forKey: id)
            reserveTaskTokens.removeValue(forKey: id)
            records.removeValue(forKey: id)
            saveStateLocked()
        }
        DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
        cleanupFiles(id)
    }

    func handleBackgroundEvents(identifier: String, completionHandler: @escaping () -> Void) -> Bool {
        guard identifier == Self.sessionIdentifier || identifier == Self.reserveSessionIdentifier else { return false }
        stateQueue.async { self.backgroundCompletionHandlers[identifier] = completionHandler }
        _ = session
        _ = reserveSession
        reconcileTasks()
        return true
    }

    func resumePendingTransfers() {
        _ = session
        _ = reserveSession
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
        let hasPendingReserve = stateQueue.sync { !reserveTaskTokens.isEmpty }
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

    private func scheduleReserve(_ record: NativeUploadRecord, earliest: Date?, cookieOverride: String? = nil) throws {
        guard record.ready, fileManager.fileExists(atPath: originalURL(record.id).path) else {
            throw NSError(domain: "NativeBackgroundUpload", code: 8, userInfo: [NSLocalizedDescriptionKey: "LOCAL_FILE_MISSING"])
        }
        guard let cookie = cookieOverride ?? cookieHeader() else {
            throw NSError(domain: "NativeBackgroundUpload", code: 9, userInfo: [NSLocalizedDescriptionKey: "APP_AUTH_REQUIRED"])
        }
        let reserveToken = UUID().uuidString
        let shouldStart = stateQueue.sync { () -> Bool in
            guard reserveTaskTokens[record.id] == nil else { return false }
            reserveTaskTokens[record.id] = reserveToken
            return true
        }
        guard shouldStart else { return }

        do {
            let payload = try reservePayload(record)
            let bodyURL = reserveBodyURL(record.id, token: reserveToken)
            try payload.write(to: bodyURL, options: .atomic)
            var request = baseRequest(url: apiBase.appendingPathComponent("api/assets/reserve"), method: "POST", cookie: cookie)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(String(payload.count), forHTTPHeaderField: "Content-Length")
            let task = reserveSession.uploadTask(with: request, fromFile: bodyURL)
            task.taskDescription = "reserve|\(record.id)|\(reserveToken)"
            task.earliestBeginDate = earliest
            let delayed = earliest.map { $0 > Date() } ?? false
            let updated = stateQueue.sync { () -> NativeUploadRecord? in
                guard var value = records[record.id],
                      value.ready,
                      value.status != "done", value.status != "failed", value.status != "paused",
                      reserveTaskTokens[record.id] == reserveToken,
                      !(value.stage == "original" && value.remoteAssetId != nil && value.uploadToken != nil) else { return nil }
                value.status = delayed || value.attempts > 0 ? "retrying" : "uploading"
                value.stage = "reserving"
                value.progress = max(value.progress, 18)
                value.attempts += 1
                value.error = delayed ? value.error : nil
                value.updatedAt = now()
                records[record.id] = value
                saveStateLocked()
                return value
            }
            guard let updated else {
                stateQueue.sync {
                    if reserveTaskTokens[record.id] == reserveToken { reserveTaskTokens.removeValue(forKey: record.id) }
                }
                task.cancel()
                try? fileManager.removeItem(at: bodyURL)
                return
            }
            notify(updated)
            task.resume()
        } catch {
            stateQueue.sync {
                if reserveTaskTokens[record.id] == reserveToken { reserveTaskTokens.removeValue(forKey: record.id) }
            }
            throw error
        }
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
        let task = session.uploadTask(with: request, fromFile: originalURL(record.id))
        task.taskDescription = "content|\(record.id)|\(contentTaskToken)"
        task.earliestBeginDate = earliest
        let delayed = earliest.map { $0 > Date() } ?? false
        let updated = stateQueue.sync { () -> NativeUploadRecord? in
            guard var value = records[record.id],
                  value.ready,
                  value.status != "done", value.status != "failed", value.status != "paused",
                  value.remoteAssetId == assetId, value.uploadToken == token,
                  value.contentTaskToken == nil else { return nil }
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
        guard let updated else {
            task.cancel()
            return
        }
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
              let uploadToken = record.uploadToken,
              task.originalRequest?.url?.path.contains("/api/assets/\(assetId)/content") == true,
              task.originalRequest?.value(forHTTPHeaderField: "X-Upload-Token") == uploadToken else { return false }
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
            self.reserveSession.getAllTasks { reserveTasks in
                let matches = (contentTasks + reserveTasks).filter { self.taskJobId($0) == id }
                let stillCurrent = self.stateQueue.sync { () -> Bool in
                    guard let expectedControlGeneration else { return true }
                    guard let record = self.records[id], (record.controlGeneration ?? 0) == expectedControlGeneration else { return false }
                    return expectedStatus == nil || record.status == expectedStatus
                }
                if stillCurrent { matches.forEach(action) }
                if let completion { self.workerQueue.async { completion(stillCurrent ? matches.count : 0) } }
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
        reserveSession.getAllTasks { dedicatedReserveTasks in
            self.session.getAllTasks { legacyAndContentTasks in
                let legacyReserveTasks = legacyAndContentTasks.filter { self.taskStage($0) == "reserve" }
                let reserveTasks = dedicatedReserveTasks + legacyReserveTasks
                let contentTasks = legacyAndContentTasks.filter { self.taskStage($0) == "content" }

                var activeReserveIds = Set<String>()
                for task in reserveTasks {
                    let taskId = self.taskJobId(task)
                    let token = self.taskToken(task) ?? "legacy:\(task.taskIdentifier)"
                    guard let id = taskId, let record = recordsById[id],
                          record.ready, record.status != "done", record.status != "failed", record.status != "paused" else {
                        if let id = taskId {
                            self.stateQueue.sync {
                                if self.reserveTaskTokens[id] == token { self.reserveTaskTokens.removeValue(forKey: id) }
                            }
                        }
                        task.cancel()
                        continue
                    }
                    if record.stage == "original", record.remoteAssetId != nil, record.uploadToken != nil {
                        self.stateQueue.sync {
                            if self.reserveTaskTokens[id] == token { self.reserveTaskTokens.removeValue(forKey: id) }
                        }
                        task.cancel()
                        continue
                    }
                    let ownsReservation = self.stateQueue.sync { () -> Bool in
                        if let current = self.reserveTaskTokens[id] { return current == token }
                        self.reserveTaskTokens[id] = token
                        return true
                    }
                    guard ownsReservation else {
                        task.cancel()
                        continue
                    }
                    if task.state == .suspended { task.resume() }
                    activeReserveIds.insert(id)
                }

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
                        if let record = ownership.1, record.stage == "original", record.remoteAssetId != nil, record.uploadToken != nil {
                            needsContentRestartIds.insert(id)
                        }
                        task.cancel()
                        continue
                    }
                    if task.state == .suspended { task.resume() }
                    // A background URLSession task is allowed to wait for connectivity or
                    // system scheduling for an extended period. Lack of didSendBodyData is
                    // not evidence that the task is dead, especially after a cold launch
                    // where lastProgressAt is intentionally in-memory only. Keep every
                    // request whose persisted owner and request capability still match;
                    // URLSession's terminal callback is the authority for retry/rebuild.
                    validContentIds.insert(id)
                }

                // contentTaskToken is persisted so an in-place relaunch can reject
                // duplicate tasks. If iOS has already discarded the owned task, clear
                // only the token observed in this reconciliation snapshot. A newly
                // scheduled task racing this pass has a different/current token and is
                // therefore never cleared here.
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
                let activeIds = activeReserveIds.union(validContentIds)
                let resumable = self.stateQueue.sync {
                    self.records.values.filter {
                        $0.ready && $0.status != "done" && $0.status != "failed" && $0.status != "paused" && !activeIds.contains($0.id)
                    }
                }
                for record in resumable {
                    if record.remoteAssetId != nil, record.uploadToken != nil, record.stage == "original" {
                        let restarting = restartIds.contains(record.id)
                        self.retryContent(record, after: restarting ? 1 : 0, reason: restarting ? "检测到后台上传停滞，正在重新连接。" : nil)
                    } else {
                        self.retryReserve(record, after: 0, reason: nil)
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
        var reserveResultIsCurrent = true
        if stage == "reserve" {
            let token = taskToken(task)
            reserveResultIsCurrent = stateQueue.sync { () -> Bool in
                if let token {
                    guard reserveTaskTokens[id] == token else { return false }
                    reserveTaskTokens.removeValue(forKey: id)
                    return true
                }
                guard reserveTaskTokens[id] == nil || reserveTaskTokens[id]?.hasPrefix("legacy:") == true else { return false }
                reserveTaskTokens.removeValue(forKey: id)
                return true
            }
            try? fileManager.removeItem(at: reserveBodyURL(id, token: token))
            DispatchQueue.main.async { self.endStagingProtectionIfIdleOnMain() }
            guard reserveResultIsCurrent else { return }
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
        if stage == "reserve" {
            handleReserveResult(record, data: data, response: response, error: nil, requestCookie: requestCookie)
            return
        }

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
    private let photoImportQueue = DispatchQueue(label: "cd.cc.joye.photo.photo-import", qos: .userInitiated, attributes: .concurrent)
    private let photoImportSlots = DispatchSemaphore(value: 3)

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
        for result in results {
            let provider = result.itemProvider
            let jobId = UUID().uuidString
            let typeIdentifier = provider.registeredTypeIdentifiers.first(where: {
                guard let type = UTType($0) else { return false }
                return type.conforms(to: .image)
            }) ?? UTType.image.identifier
            group.enter()

            // Unlimited picker selection must not become unlimited simultaneous file
            // materialization. Bound provider work to three in-flight originals so a
            // large photo batch cannot spike memory/file-provider pressure and get the
            // app jetsammed while preserving the user's full selection.
            photoImportQueue.async { [weak self] in
                guard let self else { group.leave(); return }
                let slot = self.photoImportSlots
                slot.wait()
                provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
                    guard let self else {
                        slot.signal()
                        group.leave()
                        return
                    }
                    guard let url else {
                        self.notifyPickerError(
                            batchId: batchId,
                            jobId: jobId,
                            message: error?.localizedDescription ?? "无法读取所选照片。"
                        )
                        slot.signal()
                        group.leave()
                        return
                    }
                    let type = UTType(typeIdentifier)
                    var fileName = provider.suggestedName ?? url.lastPathComponent
                    if (fileName as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension {
                        fileName += ".\(ext)"
                    }
                    let mimeType = type?.preferredMIMEType ?? "image/jpeg"
                    let modified = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? nil
                    let lastModifiedMs = modified.map { $0.timeIntervalSince1970 * 1000 }
                    NativeBackgroundUploadManager.shared.importPickedPhoto(
                        id: jobId, batchId: batchId, sourceURL: url, fileName: fileName,
                        mimeType: mimeType, lastModifiedMs: lastModifiedMs
                    ) { result in
                        if case .failure(let importError) = result {
                            self.notifyPickerError(batchId: batchId, jobId: jobId, message: importError.localizedDescription)
                        }
                        group.leave()
                    }
                    // The temporary provider URL has been copied synchronously by
                    // importPickedPhoto before it returns, so another provider may now
                    // materialize while hashing/reservation completes on workerQueue.
                    slot.signal()
                }
            }
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
                    }
                }
            }
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
