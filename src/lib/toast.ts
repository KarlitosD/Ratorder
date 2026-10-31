export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastMessage {
  id: number
  message: string
  kind: ToastKind
  actionLabel?: string
}
