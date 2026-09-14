import { z } from 'zod'

export const generationSettingsSchema = z.object({
  quality: z.enum(['fast', 'medium', 'slow']),
  model_name: z.string().trim().min(1, '请选择模型'),
  provider_id: z.string().optional(),
  style: z.string().min(1, '请选择笔记生成风格'),
  format: z.array(z.string()),
  screenshot: z.boolean().optional(),
  link: z.boolean().optional(),
  extras: z.string().optional(),
  video_understanding: z.boolean().optional(),
  video_interval: z.number().min(1, '采样间隔需为 1–30 秒').max(30, '采样间隔需为 1–30 秒').optional(),
  grid_size: z.tuple([
    z.number().int().min(1).max(10),
    z.number().int().min(1).max(10),
  ]).optional(),
})
export type GenerationSettingsValues = z.infer<typeof generationSettingsSchema>
export const generationDefaults = (modelName = ''): GenerationSettingsValues => ({
  quality: 'medium', model_name: modelName, style: 'minimal',
  video_interval: 6, grid_size: [2, 2], format: [],
})
