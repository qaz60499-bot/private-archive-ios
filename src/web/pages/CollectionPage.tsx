import { useEffect } from 'react'
import { useArchive } from '../context/ArchiveContext'
import { EmptyState, ErrorState, LoadMore, PageIntro, SkeletonGrid } from '../components/States'
import { MediaGrid } from '../features/timeline/MediaGrid'

export function CollectionPage({ type }: { type: 'people' | 'videos' | 'files' | 'favorites' }) {
  const { assets, loading, loadingMore, nextCursor, error, load, loadMore } = useArchive()
  const config = {
    people: ['人物', '只做是否有人、肖像与合照粗分类，不识别真实身份。'],
    videos: ['视频', '以浏览器截取的 poster frame 进入同一套整理流程。'],
    files: ['文件', '普通文件保留名称、类型、大小和时间，不做视觉 AI。'],
    favorites: ['收藏', '从整座档案馆里留下的个人索引。'],
  }[type]
  useEffect(() => {
    void load(type === 'videos' ? { mediaType: 'video' } : type === 'files' ? { mediaType: 'file' } : type === 'favorites' ? { favorite: true } : { category: 'people' })
  }, [type, load])
  return <div className="page"><PageIntro eyebrow="Curated view" title={config[0]} description={config[1]} count={assets.length} />{loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : assets.length ? <><MediaGrid assets={assets} />{nextCursor && <LoadMore loading={loadingMore} onLoad={() => void loadMore()} />}</> : <EmptyState title={`暂无${config[0]}`} description="新的内容完成整理后会自动出现在这里。" />}</div>
}

