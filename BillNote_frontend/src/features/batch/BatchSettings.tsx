import { useEffect } from 'react'
import { useModelStore } from '@/store/modelStore'
import GenerationSettings from '@/pages/HomePage/components/GenerationSettings'
import type { GenerationSettingsValues } from '@/pages/HomePage/components/generationSettingsSchema'

interface Props {
  value: GenerationSettingsValues
  onChange: (value: GenerationSettingsValues) => void
  disabled?: boolean
}
export default function BatchSettings({ value, onChange, disabled }: Props) {
  const models = useModelStore(state => state.modelList)
  const loadModels = useModelStore(state => state.loadEnabledModels)
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    if (!disabled && !value.model_name && models[0]) {
      onChange({ ...value, model_name: models[0].model_name, provider_id: models[0].provider_id })
    }
  }, [models, value, onChange, disabled])
  return <GenerationSettings value={value} onChange={patch => onChange({ ...value, ...patch })}
    models={models} onRefreshModels={() => { void loadModels() }} disabled={disabled} />
}
