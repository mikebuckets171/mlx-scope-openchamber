import { expect, type Frame, type FrameLocator } from '@playwright/test';

type Surface = Pick<Frame | FrameLocator, 'locator' | 'getByRole'>;

export const openMeasurementDetails = async (frame: Surface): Promise<void> => {
  const details = frame.locator('#measurement-details');
  await expect(details).toBeAttached();
  if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
};

/** Diagnostics moved into Measurement details; exercise the visible standard UI route. */
export const openServerDetails = async (frame: Surface): Promise<void> => {
  await openMeasurementDetails(frame);
  await frame.getByRole('button', { name: 'Server & Mac details', exact: true }).click();
};

/** Connections is a persistent navigation action, including on SDKs without header features. */
export const openConnections = (frame: Surface): Promise<void> =>
  frame.locator('.next-nav').getByRole('button', { name: 'Connections', exact: true }).click();
