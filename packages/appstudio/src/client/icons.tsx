import type { ReactNode } from 'react'

const shapes = {
  studio: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M3 9h18M9 9v12" /><path d="M13 13h4v4h-4z" fill="currentColor" stroke="none" /></>,
  live: <><rect x="3" y="4" width="18" height="13" rx="3" /><path d="M8 21h8M12 17v4" /><path d="m10 8 5 2.5-5 2.5Z" fill="currentColor" stroke="none" /></>,
  comment: <path d="M20 11a7 7 0 0 1-7 7H9l-5 3v-5a7 7 0 0 1-2-5 7 7 0 0 1 7-7h4a7 7 0 0 1 7 7Z" />,
  phone: <><rect x="6" y="2.5" width="12" height="19" rx="2.5" /><path d="M10 18h4" /></>,
  layout: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 8h18M9 8v13" /></>,
  prompt: <><path d="M7 4h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-6l-5 4v-4a3 3 0 0 1-2-3V7a3 3 0 0 1 3-3Z" /><path d="m11 8 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  remove: <path d="m6 6 12 12M6 18 18 6" />,
  up: <path d="m6 15 6-6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  grip: <path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" strokeWidth="3" />,
  settings: <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 4v4m7 2v4m-5 2v4" strokeWidth="3" /></>,
  heading: <path d="M5 5v14M19 5v14M5 12h14" />,
  text: <path d="M4 6h16M4 12h16M4 18h10" />,
  image: <><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8" cy="9" r="1.5" /><path d="m4 18 5-5 3 3 4-5 4 5" /></>,
  input: <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M8 9v6" /></>,
  button: <><rect x="3" y="7" width="18" height="10" rx="5" /><path d="M9 12h6" /></>,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  divider: <path d="M3 12h18" />,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  external: <path d="M13 4h7v7m0-7-9 9m7 0v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />,
  check: <path d="m5 12 4 4L19 6" />,
} satisfies Record<string, ReactNode>

export function StudioIcon({ name, size = 18 }: { name: keyof typeof shapes; size?: number }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>
}
