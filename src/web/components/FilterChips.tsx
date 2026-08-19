import { Check } from 'lucide-react'

export interface FilterOption { value: string; label: string }

export function FilterChips({ options, value, onChange }: { options: FilterOption[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="filter-chips" aria-label="筛选媒体">
      {options.map((option) => (
        <button key={option.value} type="button" className={value === option.value ? 'selected' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
          {value === option.value && <Check aria-hidden="true" />}{option.label}
        </button>
      ))}
    </div>
  )
}

