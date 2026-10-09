import { html } from './html.ts';
import { ICON } from './views/parts.ts';

/** Inline glyphs work inside the panel's image-free content security policy. */
export const DISCLOSURE_ARROW = html`<span class="disclosure-arrow" aria-hidden="true">${ICON.right}</span>`;
