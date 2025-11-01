QR Check-In / Check-Out Module

Overview

This module handles QR Code scanning for event participants using a Raspberry Pi and a USB QR scanner.
It records Check-In and Check-Out actions at each booth and updates data in the Supabase database in real time.
The information is then reflected on the central dashboard for activity tracking.

Setup
pip install -r requirements.txt

Create a .env file with the following values:
SUPABASE_URL=<your-supabase-url>
SUPABASE_KEY=<your-supabase-service-key>
BASE_NAME=CprE-Booth
MODE=checkin   # or checkout

Run the program
python server.py

How It Works
1.A participant scans their QR Code at the booth.
2.The Raspberry Pi reads the UUID from the QR scanner.
3.The system verifies whether the UUID exists in the Supabase database.
4.If it’s a valid new scan, the system records the Check-In or Check-Out with a timestamp.
5.The dashboard updates automatically in real time.

Project Structure
.
├── static/               # Static assets (CSS, JS)
├── templates/            # HTML templates for Flask server
├── venv/                 # Python virtual environment
├── .env                  # Environment variables (local use)
├── requirements.txt      # Python dependencies
├── scanner.py            # QR scanner logic for reading and sending data
├── server.py             # Flask web server for dashboard/display
├── supabase_client.py    # Handles connection and operations with Supabase
└── __pycache__/          # Cached Python files

Developer
Anupong Pongpisitsan
Raspberry Pi & QR Scanner Developer
Department of Computer Engineering, KMUTNB
