import { getAsset } from '../db/assets-repository'
import { getTelegramRuntimeConfig } from '../db/settings-repository'
import { markAnalysisFailed, markAnalysisLimited, markAnalyzing, saveAnalysis } from '../db/analysis-repository'
import type { AnalysisMessage, Env } from '../env'
import { analyzeAsset } from '../services/analysis/analyzer'
import { createStorageAdapter } from '../services/storage/factory'

export async function consumeAnalysisQueue(batch: MessageBatch<AnalysisMessage>, env: Env): Promise<void> {
  const telegram = await getTelegramRuntimeConfig(env.DB, env)
  const storage = createStorageAdapter(env, telegram.storageChatId)
  for (const message of batch.messages) {
    try {
      const asset = await getAsset(env.DB, message.body.assetId)
      if (!asset || asset.status === 'trashed') {
        message.ack()
        continue
      }
      await markAnalyzing(env.DB, asset.id)
      const result = await analyzeAsset(env, storage, asset)
      if (!result) await markAnalysisLimited(env.DB, asset.id)
      else await saveAnalysis(env.DB, asset, result)
      message.ack()
    } catch {
      await markAnalysisFailed(env.DB, message.body.assetId)
      message.retry({ delaySeconds: 30 })
    }
  }
}
