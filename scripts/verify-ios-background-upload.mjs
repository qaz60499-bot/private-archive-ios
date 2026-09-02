import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../ios/App/App/NativeBackgroundUpload.swift', import.meta.url), 'utf8')
const appDelegateSource = readFileSync(new URL('../ios/App/App/AppDelegate.swift', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('../src/web/lib/native-background-upload.ts', import.meta.url), 'utf8')
const storeSource = readFileSync(new URL('../src/web/lib/offline/store.ts', import.meta.url), 'utf8')
const processorSource = readFileSync(new URL('../src/web/lib/offline/processor.ts', import.meta.url), 'utf8')

function assert(condition, message) {
  if (!condition) throw new Error(`IOS_BACKGROUND_UPLOAD_VERIFY_FAILED: ${message}`)
}

function section(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert(from >= 0 && to > from, `missing source section ${start}`)
  return source.slice(from, to)
}

assert(source.includes('URLSessionConfiguration.background(withIdentifier: Self.reserveSessionIdentifier)'), 'reserve handshake must use a background URLSession')
assert(!source.includes('foregroundSession'), 'foreground reservation session must not return')
assert(source.includes('identifier == Self.sessionIdentifier || identifier == Self.reserveSessionIdentifier'), 'native background-event bridge must accept both sessions')
assert(appDelegateSource.includes('handleEventsForBackgroundURLSession identifier: String'), 'AppDelegate must receive iOS background URLSession wakeups')
assert(appDelegateSource.includes('NativeBackgroundUploadManager.shared.handleBackgroundEvents'), 'AppDelegate must forward background URLSession wakeups to the upload manager')
assert(appDelegateSource.includes('NativeBackgroundUploadManager.shared.resumePendingTransfers()'), 'AppDelegate must reconcile uploads on background transition')

const interrupted = section('private func recoverInterruptedStaging()', 'private func recoverRetryableFailures()')
assert(!interrupted.includes('removeItem(at: url)'), 'interrupted staging recovery must preserve partial cache')
assert(interrupted.includes('已保留现有缓存'), 'partial cache preservation must remain explicit')

const recovery = section('private func recoverRetryableFailures()', 'func createJob(')
assert(recovery.includes('record.remoteAssetId = nil'), 'failed-cache recovery must discard stale asset id')
assert(recovery.includes('record.uploadToken = nil'), 'failed-cache recovery must discard stale upload token')
assert(!recovery.includes('cleanupFiles('), 'failed-cache recovery must never release original bytes')

const pickedPhoto = section('func importPickedPhoto(', 'func appendChunk(')
assert(!pickedPhoto.includes('workerQueue.async'), 'PHPicker temporary files must be copied before loadFileRepresentation returns')
assert(pickedPhoto.includes('copyItem(at: sourceURL, to: destination)'), 'native photo picker must copy the selected original into app-owned durable storage')
assert(source.includes('PHPickerViewControllerDelegate'), 'native photo selection must use PHPicker rather than the WebView file input')
assert(source.includes('picker.dismiss(animated: true)'), 'system photo picker must dismiss immediately after the user confirms selection')
assert(source.includes('CAPPluginMethod(name: "pickPhotos"'), 'native picker must be exposed through the Capacitor bridge')

const resume = section('func resumeJob(', 'func cancelJob(')
assert(resume.includes('已从本机缓存重建上传记录'), 'manual retry must reconstruct a missing native index from durable cache')
assert(resume.includes('value.remoteAssetId = nil') && resume.includes('value.uploadToken = nil'), 'manual retry must force a fresh reservation after failure')
assert(resume.includes('scheduleReserve(retrying, earliest: nil)'), 'manual retry must restart from cached bytes')

const reserve = section('private func scheduleReserve(', 'private func handleReserveResult(')
assert(reserve.includes('reserveSession.uploadTask'), 'reservation must be owned by the dedicated background session')
assert(!reserve.includes('asyncAfter'), 'reservation retry must not depend on a suspended dispatch timer')
assert(reserve.includes('cookieOverride ?? cookieHeader()'), 'reservation recovery must be able to reuse the persisted background-task cookie')
assert(reserve.includes('value.status != "done", value.status != "failed", value.status != "paused"'), 'reserve scheduling must recheck active state before task resume')

const reserveResult = section('private func handleReserveResult(', 'private func scheduleContent(')
assert(reserveResult.includes('value.stage = "original"'), 'a successful reservation must persist content ownership before scheduling PUT')
assert(reserveResult.includes('scheduleContent(reserved, earliest: nil, cookieOverride: requestCookie)'), 'reserve completion must reuse its original request cookie when creating content upload')
assert(!reserveResult.includes('markFailedIfActive(record.id, error: code ?? "APP_AUTH_REQUIRED")'), 'temporary cold-launch auth gaps must not become terminal reserve failures')

const reconcile = section('private func reconcileTasks()', 'func urlSession(_ session: URLSession, dataTask: URLSessionDataTask')
assert(reconcile.includes('contentRequestMatchesRecord(task, record: current)'), 'reconcile must reject content tasks from stale reservations')
assert(reconcile.includes('reconcileInFlight'), 'reconciliation must be serialized')
assert(reconcile.indexOf('let recordsById = stateQueue.sync { records }') < reconcile.indexOf('reserveSession.getAllTasks'), 'record snapshot must precede URLSession task snapshots')
assert(reconcile.includes('contentTaskToken'), 'reconcile must enforce one persisted content-task owner per job')
assert(reconcile.includes('current.contentTaskToken == snapshotToken'), 'reconcile must reclaim an orphaned persisted content-task token when iOS lost the task')
assert(reconcile.includes('Date().timeIntervalSince(snapshotUpdatedAt) >= 10'), 'orphan-token reclaim must not race a freshly created content task')
assert(reconcile.includes('validContentIds'), 'reconcile must distinguish a valid content task from stale siblings')
assert(!reconcile.includes('let staleSeconds ='), 'reconcile must not kill a valid background upload merely because iOS delayed progress callbacks')

const retries = section('private func retryReserve(', 'private func complete(')
assert(retries.includes('if record.remoteAssetId != nil, record.uploadToken != nil'), 'retryReserve must reuse an existing valid reservation instead of creating duplicates')
assert(retries.includes('retryContent(reserved, after: delay'), 'existing reservation recovery must route back to content upload')
assert(retries.includes('markAwaitingAuthIfActive'), 'cold-launch auth gaps must stay recoverable during retry')
assert(source.includes('private func restartReservation(_ record: NativeUploadRecord, after delay: TimeInterval, reason: String?, cookieOverride: String? = nil)'), 'reservation restart helpers must accept the persisted background-task cookie')
assert(source.includes('scheduleReserve(retrying, earliest: delay > 0 ? Date().addingTimeInterval(delay) : nil, cookieOverride: cookieOverride)'), 'reservation restart must forward the background-task cookie')

const completion = section('private func complete(', 'private func cleanupFiles(')
assert(completion.includes('value.status != "done", value.status != "failed", value.status != "paused"'), 'completion must not overwrite paused/failed jobs')
assert(completion.includes('value.contentTaskToken = nil'), 'successful completion must release the content-task generation token')

const finishJob = section('func finishJob(', 'func listJobs()')
assert(finishJob.includes('if value.status == "failed" || value.status == "done"'), 'finishJob must not resurrect a canceled/completed job')
assert(finishJob.includes('let shouldSchedule = value.status != "paused"'), 'finishJob must preserve pause state while hashing/staging completes')
assert(finishJob.includes('self.nativeUploadErrorCode(error) == 9'), 'finishJob must not turn a temporary auth gap into a failed staged original')

const taskCompletion = section('func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?)', 'func urlSessionDidFinishEvents')
assert(taskCompletion.includes('let requestCookie = task.originalRequest?.value(forHTTPHeaderField: "Cookie")'), 'background callbacks must recover using the cookie persisted on the URLSession task')
assert(taskCompletion.includes('restartReservation(record, after: retryDelay(response), reason: code ?? "UPLOAD_TOKEN_INVALID_OR_EXPIRED", cookieOverride: requestCookie)'), 'expired content capability must explicitly clear and recreate reservation state using the persisted task cookie')
assert(!taskCompletion.includes('markFailedIfActive(id, error: code ?? "APP_AUTH_REQUIRED")'), 'APP_AUTH_REQUIRED must never be terminal in a cold background callback')

const pauseAndCancel = section('func pauseJob(', 'func resumeJob(')
assert(pauseAndCancel.includes('value.status != "done", value.status != "failed"'), 'pause must not overwrite a terminal state')
const cancel = section('func cancelJob(', 'func removeJob(')
assert(cancel.includes('guard var value = records[id], value.status != "done"'), 'cancel must not overwrite a completed upload')
assert(cancel.indexOf('value.status = "failed"') < cancel.indexOf('performOnTasks(id: id, action: { $0.cancel() })'), 'cancel state must be serialized before task cancellation callbacks')

const destructiveOriginalDeletes = [...source.matchAll(/removeItem\(at: originalURL\(id\)\)/g)]
assert(destructiveOriginalDeletes.length === 1, `cached original has ${destructiveOriginalDeletes.length} direct deletion sites; expected cleanupFiles only`)
assert(source.includes('guard records[id] == nil, !fileManager.fileExists(atPath: originalURL(id).path)'), 'createJob must refuse to overwrite an existing cache')

const enqueueCatch = bridgeSource.slice(bridgeSource.indexOf('export async function enqueueIosBackgroundUpload'), bridgeSource.indexOf('export async function syncIosBackgroundUploads'))
assert(!enqueueCatch.includes('NativeBackgroundUpload.cancelJob'), 'automatic enqueue failures must not destroy native cache')
assert(storeSource.includes("if (!opfsPath) await persistPayloadBytes(options.id, 'original', options.file)"), 'native iOS registration must persist a full Web-side recovery copy before staging')
assert(bridgeSource.includes("if (job.status === 'done') await releaseLocalUploadPayload(job.id)"), 'Web-side recovery copy must survive until native upload really completes')
assert(bridgeSource.includes('restageFromDurableFallback'), 'startup sync must be able to rebuild an interrupted native staging file from durable bytes')
assert(bridgeSource.includes("native.status === 'failed' && native.stage === 'registered'"), 'startup sync must detect interrupted native staging rather than leaving it terminally failed')
assert(bridgeSource.includes('missingNative.map((job) => resumeNativeBackgroundTransfer(job))'), 'Web startup sync must reconstruct missing native indexes from cached jobs')
assert(processorSource.includes('Promise.allSettled(jobs.map((job) => resumeLocalUpload(job.id)))'), 'batch retry must continue after an individual recovery failure')

console.log('IOS_BACKGROUND_UPLOAD_SOURCE_OK')
