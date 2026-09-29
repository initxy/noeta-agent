/**
 * Presentational primitives.
 *
 * The layer is deliberately narrow: it may import `app/` and itself, and
 * nothing else. A primitive that reaches for a store, a query, or a domain
 * type has stopped being a primitive and belongs in the domain that needs it.
 *
 * Later phases grow this from `@base-ui/react` (menus, dialogs, tooltips,
 * selects) — headless behaviour, styled here.
 */

export { Button } from './button'
export type { ButtonProps, ButtonSize, ButtonVariant } from './button'
export { Card, CardDescription, CardTitle, NotFoundCard } from './card'
export { CloseButton } from './close-button'
export type { CloseButtonProps } from './close-button'
export { cn } from './cn'
export { Logo } from './logo'
export { Modal } from './modal'
export {
  AppFrame,
  CenteredNote,
  MainPane,
  PaneBody,
  PaneHeader,
  RailSection,
  SidebarRail,
} from './layout'
