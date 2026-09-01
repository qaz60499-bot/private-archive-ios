import { getAsset } from '../db/assets-repository'
import { resolveTelegramSourceConfig } from '../db/telegram-sources-repository'
import { markAnalysisFailed, markAnalysisLimited, markAnalyzing, saveAnalysis } from '../db/analysis-repository'
import type { AnalysisMessage, Env } from '../env'
import { analyzeAsset } from '../services/analysis/analyzer'
import { isMockMode } from '../env'
import { createStorageAdapterFromConfig } from '../services/storage/factory'

export async function consumeAnalysisQueue(batch: MessageBatch<AnalysisMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      const asset = await getAsset(env.DB, message.body.assetId)
      if (!asset || asset.status === 'trashed') {
        message.ack()
        continue
      }
      const source = isMockMode(env)
        ? { token: 'mock', storageChatId: '-1000000000000' }
        : await resolveTelegramSourceConfig(env.DB, env, asset.source_id)
      const storage = createStorageAdapterFromConfig(env, source)
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
