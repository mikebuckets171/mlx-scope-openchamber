import { expect, type Frame, type FrameLocator, type Locator } from '@playwright/test';

type Surface = Pick<Frame | FrameLocator, 'locator' | 'getByRole'>;

/**
 * Open a native <details> and wait until it really is open. On a hosted WebKit runner one click on this summary once left the
 * disclosure closed for the whole 5 s wait, so a closed disclosure is clicked again (bounded) instead of trusting a single click.
 */
export const openDetails = async (details: Locator): Promise<void> => {
  await expect(details).toBeAttached();
  await expect(async () => {
    if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator(':scope > summary').click({ timeout: 2_000 });
    expect(await details.evaluate(node => (node as HTMLDetailsElement).open)).toBe(true);
  }).toPass({ timeout: 10_000 });
};

export const openMeasurementDetails = (frame: Surface): Promise<void> => openDetails(frame.locator('#measurement-details'));

/** The Engine server strip lives inside Measurement details; exercise the visible standard UI route. */
export const openServerDetails = async (frame: Surface): Promise<void> => {
  await openMeasurementDetails(frame);
  await expect(frame.locator('#server-strip')).toBeVisible();
};

/** Connections is a persistent navigation action, including on SDKs without header features. */
export const openConnections = (frame: Surface): Promise<void> =>
  frame.locator('.next-nav').getByRole('button', { name: 'Connections', exact: true }).click();
