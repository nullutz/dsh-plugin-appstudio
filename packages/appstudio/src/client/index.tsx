import { useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import contribution from '../../lib/typert.remote-client.js'
import { en, namespace, zh, type StudioKey } from './copy.ts'
import { StudioIcon } from './icons.tsx'
import { createRuntimeLease, Workbench, type StudioRemote } from './workbench.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    appStudio: StudioKey
  }
}

export const inject = ['remote', 'slots', 'locale', 'uiWorkspace', 'sessions']
const panelId = 'dsh-plugin-appstudio'

function PanelIcon({ size }: SidebarPanelIconOwnerProps) {
  return <StudioIcon name="studio" size={size} />
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, { en, zh }), 'App Studio dictionaries')
  const translate = ctx.locale.bind(namespace)
  const remote: StudioRemote = ctx.remote.appStudio
  const runtimeLease = createRuntimeLease(remote)
  ctx.effect(() => () => runtimeLease.stop(), 'App Studio Android runtime lease')
  const openSession = (id: string) => ctx.uiWorkspace.openSession(id as SessionId)
  const pickDirectory = () => ctx.uiWorkspace.pickDirectory()
  const watchSessions = (listener: () => void) => ctx.sessions.list.subscribe(listener)
  const readSessions = (): SessionListState => ctx.sessions.list.getSnapshot()
  function Panel({ t, useWorkspaces }: PropsRuntime<'main'> & PropsLocale<typeof namespace>) {
    const sessions = useSyncExternalStore(watchSessions, readSessions)
    const currentSession = Object.values(sessions.byId).find(session =>
      Object.entries(session.retainedBy).some(([source, count]) => source === 'mainView' && typeof count === 'number' && count > 0))?.id
    const workspaceRoot = useWorkspaces((state: { items: readonly { path: string; sessionIds: readonly SessionId[] }[] }) => currentSession
      ? state.items.find(workspace => workspace.sessionIds.includes(currentSession))?.path ?? ''
      : '')
    return <Workbench remote={remote} t={t} onOpenSession={openSession} onPickDirectory={pickDirectory}
      workspaceRoot={workspaceRoot} runtimeLease={runtimeLease} />
  }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: panelId,
    locale: namespace,
  }, Panel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: panelId,
    label: () => translate('title'),
  }, PanelIcon))
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.appStudio', 'slots', 'locale', 'uiWorkspace', 'sessions'], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
