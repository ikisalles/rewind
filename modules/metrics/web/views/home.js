// Home widgets: shortcut, onboarding and failing sources. No individual data.
import { button } from '@rewind/web/ui.js';

export const home = {
  actions: ({ data }) => (data.metrics?.teamsWithMetrics?.length ? [button('Engineering metrics', { iconName: 'rocket', onClick: () => (location.hash = '#/metrics') })] : []),
  metrics: ({ data }) => (data.metrics?.runningExperiments ? [['Running experiments', data.metrics.runningExperiments]] : []),
  onboarding: () => [
    { key: 'metricsSource', title: 'Connect an engineering data source', hint: 'GitHub or your deploy pipeline.', href: '#/admin/metrics-settings' },
    { key: 'metricsScope', title: 'Map repositories to teams', hint: 'Metrics are attributed per team, with history.', href: '#/admin/metrics-settings' },
  ],
  housekeeping: ({ data }) =>
    (data.admin?.metrics?.failingSources || []).map((s) => ({
      icon: 'alert',
      title: `Metrics source "${s.name}" is failing`,
      hint: `${s.lastError || 'Ingestion failed'}. Dashboards show a data gap until it recovers.`,
      href: '#/admin/metrics-settings',
      cta: 'Check',
    })),
};
