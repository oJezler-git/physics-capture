import { test, expect } from '@playwright/test';

test.describe('The Golden Path', () => {
  test('should allow a user to navigate from setup to results', async ({ page }) => {
    // 1. Mock critical API calls
    await page.route('**/api/experiments', async (route) => {
      await route.fulfill({ json: ['test-exp'] });
    });

    await page.route('**/api/experiments/test-exp/metadata', async (route) => {
      await route.fulfill({
        json: {
          id: 'test-exp',
          frameCount: 10,
          frameMap: Array(10).fill('000001.png'),
          resolution: '1280x720',
        },
      });
    });

    await page.route('**/api/experiments/test-exp/frames/**', async (route) => {
      // Return a 1x1 transparent PNG pixel
      const buffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      );
      await route.fulfill({ contentType: 'image/png', body: buffer });
    });

    await page.route('**/api/track', async (route) => {
      await route.fulfill({
        json: {
          experiment_id: 'test-exp',
          progress: 1.0,
          tracks: [
            {
              ballId: 0,
              cameraId: 0,
              points: [
                { frameIdx: 0, x: 100, y: 100, confidence: 1.0 },
                { frameIdx: 5, x: 200, y: 100, confidence: 1.0 },
              ],
            },
          ],
        },
      });
    });

    await page.route('**/api/experiments/test-exp/physics', async (route) => {
      await route.fulfill({
        json: {
          balls: [{ ballId: 0, v_before: { value: 1.0, uncertainty: 0.1 }, v_after: { value: -0.5, uncertainty: 0.1 } }],
          system: {
            coeff_of_restitution: { value: 0.5, uncertainty: 0.05 },
          },
        },
      });
    });

    // 2. Start the flow
    await page.goto('/');
    
    // Select existing experiment
    await page.getByText('test-exp').first().click();
    await page.getByRole('button', { name: /Open/i }).click();

    // Now on Tracking Page
    await expect(page).toHaveURL(/.*tracking/);
    
    // Simulate placing a seed (simple click on canvas)
    await page.locator('canvas').first().click({ position: { x: 100, y: 100 } });
    
    // Start tracking
    await page.getByRole('button', { name: /Start Tracking/i }).click();
    
    // Wait for "View Results" to appear after tracking completes
    const resultsBtn = page.getByRole('button', { name: /View Results/i });
    await expect(resultsBtn).toBeVisible({ timeout: 10000 });
    await resultsBtn.click();

    // Now on Results Page
    await expect(page).toHaveURL(/.*results/);
    await expect(page.getByText('Coefficient of Restitution')).toBeVisible();
    await expect(page.getByText('0.50')).toBeVisible();
  });
});
