/** Common chrome of a left flyout panel: title, optional close button, scrolling body. */
import type { JSX, ReactNode } from 'react';
import { IconButton, cx } from '../components/ui.tsx';

export interface PanelShellProps {
  title: string;
  onClose?: () => void;
  children: ReactNode;
  /** Content pinned above the scrolling body (search fields, tabs). */
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  id?: string;
}

export function PanelShell({ title, onClose, children, header, footer, className, id }: PanelShellProps): JSX.Element {
  return (
    <section className={cx('panel', className)} aria-label={title} id={id}>
      <div className="panel__head">
        <h2 className="panel__title">{title}</h2>
        {onClose && <IconButton label="Close panel" icon="chevronLeft" size="sm" onClick={onClose} />}
      </div>
      {header && <div className="panel__sub">{header}</div>}
      <div className="panel__body">{children}</div>
      {footer && <div className="panel__foot">{footer}</div>}
    </section>
  );
}
