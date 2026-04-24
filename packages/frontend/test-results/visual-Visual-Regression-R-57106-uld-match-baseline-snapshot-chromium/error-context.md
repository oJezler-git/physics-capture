# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual.spec.ts >> Visual Regression >> ResultsPage should match baseline snapshot
- Location: tests-e2e\visual.spec.ts:4:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Coefficient of Restitution')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for getByText('Coefficient of Restitution')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e6]: online
  - main [ref=e7]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('Visual Regression', () => {
  4  |   test('ResultsPage should match baseline snapshot', async ({ page }) => {
  5  |     // 1. Mock API calls to get into a stable state
  6  |     await page.route('**/api/experiments', async (route) => {
  7  |       await route.fulfill({ json: ['test-exp'] });
  8  |     });
  9  | 
  10 |     await page.route('**/api/experiments/test-exp/physics', async (route) => {
  11 |         await route.fulfill({
  12 |           json: {
  13 |             balls: [{ ballId: 0, v_before: { value: 1.0, uncertainty: 0.1 }, v_after: { value: -0.5, uncertainty: 0.1 } }],
  14 |             system: {
  15 |               coeff_of_restitution: { value: 0.5, uncertainty: 0.05 },
  16 |             },
  17 |           },
  18 |         });
  19 |       });
  20 | 
  21 |     await page.goto('/results/test-exp');
  22 |     
  23 |     // Wait for the UI to be fully rendered
> 24 |     await expect(page.getByText('Coefficient of Restitution')).toBeVisible();
     |                                                                ^ Error: expect(locator).toBeVisible() failed
  25 | 
  26 |     // Take snapshot
  27 |     await expect(page).toHaveScreenshot('results-page.png');
  28 |   });
  29 | });
  30 | 
```