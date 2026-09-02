import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../ios/App/App/NativeBackgroundUpload.swift', import.meta.url), 'utf8')
const bridgeSource = readFileSync(new URL('../src/web/lib/native-background-upload.ts', import.meta.url), 'utf8')
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
assert(source.includes('identifier == Self.sessionIdentifier || identifier == Self.reserveSessionIdentifier'), 'AppDelegate background-event bridge must accept both sessions')

const interrupted = section('private func recoverInterruptedStaging()', 'private func recoverRetryableFailures()')
assert(!interrupted.includes('removeItem(at: url)'), 'interrupted staging recovery must preserve partial cache')
assert(interrupted.includes('已保留现有缓存'), 'partial cache preservation must remain explicit')

const recovery = section('private func recoverRetryableFailures()', 'func createJob(')
assert(recovery.includes('record.remoteAssetId = nil'), 'failed-cache recovery must discard stale asset id')
assert(recovery.includes('record.uploadToken = nil'), 'failed-cache recovery must discard stale upload token')
assert(!recovery.includes('cleanupFiles('), 'failed-cache recovery must never release original bytes')

const resume = section('func resumeJob(', 'func cancelJob(')
assert(resume.includes('已从本机缓存重建上传记录'), 'manual retry must reconstruct a missing native index from durable cache')
assert(resume.includes('value.remoteAssetId = nil') && resume.includes('value.uploadToken = nil'), 'manual retry must force a fresh reservation after failure')
assert(resume.includes('scheduleReserve(retrying, earliest: nil)'), 'manual retry must restart from cached bytes')

const reserve = section('private func scheduleReserve(', 'private func handleReserveResult(')
assert(reserve.includes('reserveSession.uploadTask'), 'reservation must be owned by the dedicated background session')
assert(!reserve.includes('asyncAfter'), 'reservation retry must not depend on a suspended dispatch timer')
assert(reserve.includes('value.status != "done", value.status != "failed", value.status != "paused"'), 'reserve scheduling must recheck active state before task resume')

const reconcile = section('private func reconcileTasks()', 'func urlSession(_ session: URLSession, dataTask: URLSessionDataTask')
assert(reconcile.includes('contentRequestMatchesRecord(task, record: current)'), 'reconcile must reject content tasks from stale reservations')
assert(reconcile.includes('contentTaskToken'), 'reconcile must enforce one persisted content-task owner per job')
assert(reconcile.includes('current.contentTaskToken == snapshotToken'), 'reconcile must reclaim an orphaned persisted content-task token when iOS lost the task')
assert(reconcile.includes('validContentIds'), 'reconcile must distinguish a valid content task from stale siblings')

const completion = section('private func complete(', 'private func cleanupFiles(')
assert(completion.includes('value.status != "done", value.status != "failed", value.status != "paused"'), 'completion must not overwrite paused/failed jobs')
assert(completion.includes('value.contentTaskToken = nil'), 'successful completion must release the content-task generation token')

const finishJob = section('func finishJob(', 'func listJobs()')
assert(finishJob.includes('let shouldSchedule = value.status != "paused"'), 'finishJob must preserve pause state while hashing/staging completes')

const destructiveOriginalDeletes = [...source.matchAll(/removeItem\(at: originalURL\(id\)\)/g)]
assert(destructiveOriginalDeletes.length === 1, `cached original has ${destructiveOriginalDeletes.length} direct deletion sites; expected cleanupFiles only`)
assert(source.includes('guard records[id] == nil, !fileManager.fileExists(atPath: originalURL(id).path)'), 'createJob must refuse to overwrite an existing cache')

const enqueueCatch = bridgeSource.slice(bridgeSource.indexOf('export async function enqueueIosBackgroundUpload'), bridgeSource.indexOf('export async function syncIosBackgroundUploads'))
assert(!enqueueCatch.includes('NativeBackgroundUpload.cancelJob'), 'automatic enqueue failures must not destroy native cache')
assert(bridgeSource.includes('missingNative.map((job) => resumeNativeBackgroundTransfer(job))'), 'Web startup sync must reconstruct missing native indexes from cached jobs')
assert(processorSource.includes('Promise.allSettled(jobs.map((job) => resumeLocalUpload(job.id)))'), 'batch retry must continue after an individual recovery failure')

console.log('IOS_BACKGROUND_UPLOAD_SOURCE_OK')
