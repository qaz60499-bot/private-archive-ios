import { useEffect, useState } from 'react'
import { MapPin } from 'lucide-react'
import { PageIntro, EmptyState } from '../components/States'

interface Place { id: string; label: string; city?: string; asset_count: number; latest_taken_at?: string }

export function PlacesPage() {
  const [places, setPlaces] = useState<Place[]>([])
  useEffect(() => { void fetch('/api/places').then((response) => response.json() as Promise<{ items: Place[] }>).then((data) => setPlaces(data.items)) }, [])
  return <div className="page"><PageIntro eyebrow="Coordinates · 04" title="地点不是猜出来的" description="只有 EXIF GPS 或明确命名才会进入地点索引；未配置反向地理服务时保留坐标并显示待解析。" />{places.length ? <div className="place-grid">{places.map((place) => <article className="place-card" key={place.id}><MapPin /><p>{place.city ?? '已命名地点'}</p><h2>{place.label}</h2><span>{place.asset_count} 项 · {place.latest_taken_at ? new Date(place.latest_taken_at).toLocaleDateString('zh-CN') : '暂无日期'}</span></article>)}</div> : <EmptyState title="尚无地点索引" description="上传包含 GPS 的照片后，经纬度会被保存；系统不会凭街景虚构地址。" />}</div>
}

