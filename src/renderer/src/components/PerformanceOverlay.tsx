import './PerformanceOverlay.css'

export interface PerfRow {
  id: string
  name: string
  visible: boolean
  mainBytesPerSec: number
  mainEventsPerSec: number
  ipcPerSec: number
  rendererBytesPerSec: number
  hiddenBytesPerSec: number
  terminalWritesPerSec: number
  processPollsPerSec: number
  outputFlushesPerSec: number
  totalMainBytes: number
  totalRendererBytes: number
}

export interface PerfOverlayModel {
  capturedAt: number
  mainCpuPercent: number | null
  mainMemoryMb: number | null
  webglStatus: 'on' | 'failed' | 'pending' | 'off'
  webglActivations: number
  webglFailures: number
  webglContextLosses: number
  webglDisabled: number
  vibrancyDisabled: boolean
  activePtys: number
  totalMainBytesPerSec: number
  totalMainEventsPerSec: number
  totalIpcPerSec: number
  totalRendererBytesPerSec: number
  totalHiddenBytesPerSec: number
  totalTerminalWritesPerSec: number
  totalProcessPollsPerSec: number
  totalOutputFlushesPerSec: number
  rows: PerfRow[]
}

interface Props {
  model: PerfOverlayModel | null
  error?: string | null
  onClose: () => void
}

function formatRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (value >= 10) return value.toLocaleString(undefined, { maximumFractionDigits: 1 })
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function formatBytesPerSec(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B/s'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB/s`
  return `${value.toFixed(0)} B/s`
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value.toFixed(0)} B`
}

export default function PerformanceOverlay({ model, error = null, onClose }: Props) {
  const rows = model?.rows.slice(0, 10) ?? []
  const webglStatus = model?.webglStatus ?? 'pending'

  return (
    <div className="perf-overlay" role="status" aria-label="Performance diagnostics">
      <div className="perf-overlay__header">
        <div>
          <div className="perf-overlay__title-row">
            <span className="perf-overlay__title">Performance</span>
            <span
              className={`perf-overlay__badge perf-overlay__badge--${webglStatus}`}
              title={`Activations: ${model?.webglActivations ?? 0}, failures: ${model?.webglFailures ?? 0}, context losses: ${model?.webglContextLosses ?? 0}, disabled panes: ${model?.webglDisabled ?? 0}`}
            >
              WebGL {webglStatus === 'on' ? 'on' : webglStatus}
            </span>
            <span
              className={`perf-overlay__badge ${model?.vibrancyDisabled ? 'perf-overlay__badge--off' : 'perf-overlay__badge--on'}`}
              title={model?.vibrancyDisabled ? 'Window vibrancy and transparency are disabled' : 'Window vibrancy and transparency are enabled'}
            >
              Vibrancy {model?.vibrancyDisabled ? 'off' : 'on'}
            </span>
          </div>
          <div className="perf-overlay__subtitle">Cmd+Shift+P toggles diagnostics</div>
        </div>
        <button className="perf-overlay__close" onClick={onClose} title="Hide performance diagnostics">x</button>
      </div>

      <div className="perf-overlay__summary">
        <div><span>PTYs</span><strong>{model?.activePtys ?? 0}</strong></div>
        <div><span>Main CPU</span><strong>{model?.mainCpuPercent == null ? 'n/a' : `${model.mainCpuPercent.toFixed(1)}%`}</strong></div>
        <div><span>Main Mem</span><strong>{model?.mainMemoryMb == null ? 'n/a' : `${model.mainMemoryMb.toFixed(0)} MB`}</strong></div>
        <div><span>PTY bytes</span><strong>{formatBytesPerSec(model?.totalMainBytesPerSec ?? 0)}</strong></div>
        <div><span>IPC msgs</span><strong>{formatRate(model?.totalIpcPerSec ?? 0)}/s</strong></div>
        <div><span>xterm writes</span><strong>{formatRate(model?.totalTerminalWritesPerSec ?? 0)}/s</strong></div>
        <div><span>Hidden bytes</span><strong>{formatBytesPerSec(model?.totalHiddenBytesPerSec ?? 0)}</strong></div>
        <div><span>Polls</span><strong>{formatRate(model?.totalProcessPollsPerSec ?? 0)}/s</strong></div>
      </div>

      {error && (
        <div className="perf-overlay__error">
          {error}
        </div>
      )}

      <table className="perf-overlay__table">
        <thead>
          <tr>
            <th>Tab</th>
            <th>PTY</th>
            <th>IPC</th>
            <th>xterm</th>
            <th>Hidden</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          {error ? (
            <tr><td colSpan={6} className="perf-overlay__empty">Diagnostics unavailable</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={6} className="perf-overlay__empty">No active PTY stats yet</td></tr>
          ) : rows.map((row) => (
            <tr key={row.id}>
              <td>
                <span className={`perf-overlay__dot ${row.visible ? 'is-visible' : ''}`} />
                {row.name}
              </td>
              <td>{formatBytesPerSec(row.mainBytesPerSec)}</td>
              <td>{formatRate(row.ipcPerSec)}/s</td>
              <td>{formatRate(row.terminalWritesPerSec)}/s</td>
              <td>{formatBytesPerSec(row.hiddenBytesPerSec)}</td>
              <td>{formatBytes(row.totalRendererBytes || row.totalMainBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
