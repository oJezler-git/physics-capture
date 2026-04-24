# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: golden-path.spec.ts >> The Golden Path >> should allow a user to navigate from setup to results
- Location: tests-e2e\golden-path.spec.ts:4:3

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByText('test-exp').first()

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e6]: online
  - main [ref=e7]:
    - generic [ref=e8]:
      - generic [ref=e9]:
        - generic [ref=e10]:
          - paragraph [ref=e11]: Phase 01 - Session Setup
          - heading "Build Capture Session" [level=1] [ref=e12]
          - paragraph [ref=e13]: Pair recording phones with a canonical room ID, portable invite URL, and readable quick code.
        - generic [ref=e14]: Session active
      - generic [ref=e16]:
        - generic [ref=e17]:
          - generic [ref=e18]:
            - paragraph [ref=e19]: Phone Handshake
            - heading "Device Entry Portal" [level=2] [ref=e20]
          - generic [ref=e21]:
            - generic [ref=e22]: Code A315C-18BFB
            - generic [ref=e23]: Local Network
        - generic [ref=e24]:
          - img "Join QR code" [ref=e26]
          - generic [ref=e27]:
            - generic [ref=e28]:
              - paragraph [ref=e29]: Invite Details
              - paragraph [ref=e30]: Recording profile
              - generic [ref=e31]:
                - button "Legacy Original lower-bitrate path. Small files, weakest detail." [ref=e32] [cursor=pointer]:
                  - generic [ref=e33]: Legacy
                  - generic [ref=e34]: Original lower-bitrate path. Small files, weakest detail.
                - button "Browser High Recommended browser-only path with higher capture quality." [ref=e35] [cursor=pointer]:
                  - generic [ref=e36]: Browser High
                  - generic [ref=e37]: Recommended browser-only path with higher capture quality.
                - button "Extreme Future frame-capture path. Not implemented yet." [disabled] [ref=e38]:
                  - generic [ref=e39]: Extreme
                  - generic [ref=e40]: Future frame-capture path. Not implemented yet.
              - paragraph [ref=e41]: Quick code
              - generic [ref=e42]:
                - paragraph [ref=e43]: A315C-18BFB
                - button "Copy" [ref=e44] [cursor=pointer]
              - paragraph [ref=e45]: Session key
              - generic [ref=e46]:
                - paragraph [ref=e47]: a315c18b-fb08-41fc-b437-3d86eb491e1c
                - button "Copy" [ref=e48] [cursor=pointer]
              - paragraph [ref=e49]: Invite URL
              - generic [ref=e50]:
                - paragraph [ref=e51]: https://172.20.10.2:3000/phone?room=exp-a315c18b-fb08-41fc-b437-3d86eb491e1c&code=A315C-18BFB&sid=a315c18b-fb08-41fc-b437-3d86eb491e1c&recording=browser-high
                - button "Copy" [ref=e52] [cursor=pointer]
              - paragraph [ref=e53]: WebSocket wss://172.20.10.2:3000/ws
              - paragraph [ref=e54]: Host source auto-detected LAN IP
            - generic [ref=e55]:
              - generic [ref=e56]:
                - paragraph [ref=e57]: Connected Devices
                - generic [ref=e58]: 0 linked
              - generic [ref=e59]: Waiting for phones to join...
      - button "Continue to Calibration" [ref=e61] [cursor=pointer]
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | test.describe('The Golden Path', () => {
  4  |   test('should allow a user to navigate from setup to results', async ({ page }) => {
  5  |     // 1. Mock critical API calls
  6  |     await page.route('**/api/experiments', async (route) => {
  7  |       await route.fulfill({ json: ['test-exp'] });
  8  |     });
  9  | 
  10 |     await page.route('**/api/experiments/test-exp/metadata', async (route) => {
  11 |       await route.fulfill({
  12 |         json: {
  13 |           id: 'test-exp',
  14 |           frameCount: 10,
  15 |           frameMap: Array(10).fill('000001.png'),
  16 |           resolution: '1280x720',
  17 |         },
  18 |       });
  19 |     });
  20 | 
  21 |     await page.route('**/api/experiments/test-exp/frames/**', async (route) => {
  22 |       // Return a 1x1 transparent PNG pixel
  23 |       const buffer = Buffer.from(
  24 |         'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
  25 |         'base64',
  26 |       );
  27 |       await route.fulfill({ contentType: 'image/png', body: buffer });
  28 |     });
  29 | 
  30 |     await page.route('**/api/track', async (route) => {
  31 |       await route.fulfill({
  32 |         json: {
  33 |           experiment_id: 'test-exp',
  34 |           progress: 1.0,
  35 |           tracks: [
  36 |             {
  37 |               ballId: 0,
  38 |               cameraId: 0,
  39 |               points: [
  40 |                 { frameIdx: 0, x: 100, y: 100, confidence: 1.0 },
  41 |                 { frameIdx: 5, x: 200, y: 100, confidence: 1.0 },
  42 |               ],
  43 |             },
  44 |           ],
  45 |         },
  46 |       });
  47 |     });
  48 | 
  49 |     await page.route('**/api/experiments/test-exp/physics', async (route) => {
  50 |       await route.fulfill({
  51 |         json: {
  52 |           balls: [{ ballId: 0, v_before: { value: 1.0, uncertainty: 0.1 }, v_after: { value: -0.5, uncertainty: 0.1 } }],
  53 |           system: {
  54 |             coeff_of_restitution: { value: 0.5, uncertainty: 0.05 },
  55 |           },
  56 |         },
  57 |       });
  58 |     });
  59 | 
  60 |     // 2. Start the flow
  61 |     await page.goto('/');
  62 |     
  63 |     // Select existing experiment
> 64 |     await page.getByText('test-exp').first().click();
     |                                              ^ Error: locator.click: Test timeout of 30000ms exceeded.
  65 |     await page.getByRole('button', { name: /Open/i }).click();
  66 | 
  67 |     // Now on Tracking Page
  68 |     await expect(page).toHaveURL(/.*tracking/);
  69 |     
  70 |     // Simulate placing a seed (simple click on canvas)
  71 |     await page.locator('canvas').first().click({ position: { x: 100, y: 100 } });
  72 |     
  73 |     // Start tracking
  74 |     await page.getByRole('button', { name: /Start Tracking/i }).click();
  75 |     
  76 |     // Wait for "View Results" to appear after tracking completes
  77 |     const resultsBtn = page.getByRole('button', { name: /View Results/i });
  78 |     await expect(resultsBtn).toBeVisible({ timeout: 10000 });
  79 |     await resultsBtn.click();
  80 | 
  81 |     // Now on Results Page
  82 |     await expect(page).toHaveURL(/.*results/);
  83 |     await expect(page.getByText('Coefficient of Restitution')).toBeVisible();
  84 |     await expect(page.getByText('0.50')).toBeVisible();
  85 |   });
  86 | });
  87 | 
```