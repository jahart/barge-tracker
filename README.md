# Ohio River Barge Tracker

Live AIS vessel tracker for the Ohio River between OVRC Launch (Parkersburg WV) and Neal Island. Built to check for barge traffic before rowing.

## Setup

1. Sign up for a free API key at https://aisstream.io
2. Copy your key into `.env`:
   ```
   AISSTREAM_API_KEY=your_key_here
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the server:
   ```bash
   npm start
   ```
5. Open http://localhost:3000

## Viewing on your phone via ngrok

1. Install ngrok: https://ngrok.com/download
2. Start the app: `npm start`
3. In a second terminal: `ngrok http 3000`
4. Open the `https://...ngrok-free.app` URL on your Pixel

The ngrok URL changes each session unless you have a paid plan. Free plan is fine for pre-row checks.

## Danger zone

A 2-mile radius circle is drawn around OVRC Launch. When any vessel enters that zone, a red alert banner fires with the vessel name, direction, speed, and estimated minutes to the launch site.

## AIS coverage note

Not all vessels broadcast AIS. Large commercial barges and towboats are required to carry AIS — smaller recreational craft are not. Coverage on the Ohio River is generally good for commercial traffic.
