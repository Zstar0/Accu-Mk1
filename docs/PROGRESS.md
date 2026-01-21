# Progress Log

## 2026-01-20: v0.3.0 - API Profiles & Settings

### New Features

- **API Profiles**: Save and switch between multiple server + API key configurations
  - Profile dropdown in Settings → General
  - Server URL field for configuring Integration Service endpoint
  - API Key field with show/hide toggle
  - Save Profile / Connect / Delete Profile buttons
  - Default profiles: "Local Development" and "Production"
  - Migration from old API key format on first load
- **Connect Button**: Saves profile and resets app connection in one click
- **Profile Indicator**: Shows active profile name in version footer (e.g., `Accu-Mk1 Ver. 0.3.0 • Local Development`)

### Files Created

| File                      | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `src/lib/api-profiles.ts` | Profile storage module with localStorage persistence |

### Files Modified

| File                                               | Changes                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `src/lib/config.ts`                                | Dynamic URL via `getApiBaseUrl()`                 |
| `src/lib/api.ts`                                   | Uses profile-based URL and API key                |
| `src/components/preferences/panes/GeneralPane.tsx` | Profile management UI                             |
| `src/components/layout/MainWindow.tsx`             | Profile indicator in footer                       |
| `src/components/layout/MainWindowContent.tsx`      | Uses api-profiles for key check                   |
| `src/App.tsx`                                      | Uses api-profiles and listens for profile changes |
| `package.json`                                     | Bumped version to 0.3.0                           |

---

## 2026-01-18: v0.2.0 - Order Explorer Enhancements

### New Features

- **Payload Viewer**: View raw WordPress order payload data
  - "View" button in Orders table opens formatted payload panel
  - Displays billing, COA info, samples, services, pricing in readable sections
  - Includes raw JSON view for debugging
- **Resizable Table Columns**: Drag column headers to adjust width
- **Processing Time Columns**: Added to both Orders and Ingestions tables
  - Orders: Shows time from order creation to completion
  - Ingestions: Shows time from order creation to COA delivery (end-to-end turnaround)
- **Completed At Columns**: Shows when orders/ingestions finished processing
- **Version Footer**: App now displays "Accu-Mk1 Ver. 0.2.0" at bottom center

### Files Created

| File                                         | Description                                      |
| -------------------------------------------- | ------------------------------------------------ |
| `src/components/PayloadPanel.tsx`            | Payload viewer component with formatted sections |
| `src/components/ui/resizable-table-head.tsx` | Draggable column resize component                |

### Files Modified

| File                                   | Changes                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `package.json`                         | Bumped version to 0.2.0                                                     |
| `backend/integration_db.py`            | Added `payload` to orders query                                             |
| `backend/main.py`                      | Added `payload` to `ExplorerOrderResponse` schema                           |
| `src/lib/api.ts`                       | Added `payload` to `ExplorerOrder` interface                                |
| `src/components/OrderExplorer.tsx`     | Added payload button, resizable columns, processing time, completed columns |
| `src/components/layout/MainWindow.tsx` | Added version footer                                                        |

---

## 2026-01-17: Order Explorer Tool

Added a new debugging tool to the **AccuMark Tools** section for visualizing orders and ingestions from the Integration Service PostgreSQL database.

### Features

- **Environment Switching**: Dropdown to switch between Local and Production databases at runtime
- **Orders Table**: View all orders with status, sample counts, and timestamps
- **Search**: Filter orders by Order ID or Order Number
- **Ingestions Panel**: Click an order to see its COA ingestion records
- **Clickable Verification Codes**: Codes link directly to the WordPress verify page

### Files Created

| File                               | Description                                                      |
| ---------------------------------- | ---------------------------------------------------------------- |
| `backend/integration_db.py`        | PostgreSQL connection module with environment switching          |
| `backend/.env`                     | Environment config (local/production database + WordPress hosts) |
| `backend/.env.example`             | Template for .env file                                           |
| `src/components/OrderExplorer.tsx` | Main React component                                             |
| `src/components/ui/table.tsx`      | Added via shadcn                                                 |

### Files Modified

| File                               | Changes                                  |
| ---------------------------------- | ---------------------------------------- |
| `backend/main.py`                  | Added Explorer API endpoints             |
| `backend/requirements.txt`         | Added `psycopg2-binary`, `python-dotenv` |
| `src/lib/api.ts`                   | Added Explorer API functions and types   |
| `src/components/AccuMarkTools.tsx` | Integrated OrderExplorer component       |
| `.gitignore`                       | Added `.env` to ignored files            |

### API Endpoints

| Endpoint                                 | Method | Description                                        |
| ---------------------------------------- | ------ | -------------------------------------------------- |
| `/explorer/status`                       | GET    | Test database connection, returns environment info |
| `/explorer/environments`                 | GET    | List available environments                        |
| `/explorer/environments`                 | POST   | Switch active environment                          |
| `/explorer/orders`                       | GET    | List orders with optional search/pagination        |
| `/explorer/orders/{order_id}/ingestions` | GET    | Get ingestions for an order                        |

### Environment Variables

```env
# Set active environment
INTEGRATION_DB_ENV=local

# Local database
INTEGRATION_DB_LOCAL_HOST=localhost
INTEGRATION_DB_LOCAL_PORT=5432
INTEGRATION_DB_LOCAL_NAME=accumark_integration
INTEGRATION_DB_LOCAL_USER=postgres
INTEGRATION_DB_LOCAL_PASSWORD=accumark_dev_secret
WORDPRESS_LOCAL_HOST=https://accumarklabs.local

# Production database
INTEGRATION_DB_PROD_HOST=...
INTEGRATION_DB_PROD_PORT=25060
INTEGRATION_DB_PROD_NAME=accumark_integration
INTEGRATION_DB_PROD_USER=...
INTEGRATION_DB_PROD_PASSWORD=...
WORDPRESS_PROD_HOST=https://accumarklabs.kinsta.cloud
```

### Usage

1. Start the backend: `cd backend && uvicorn main:app --port 8009 --reload`
2. Start the frontend: `npm run dev`
3. Navigate to **AccuMark Tools** in the left sidebar
4. Use the dropdown to switch between Local and Production
5. Click an order to view its ingestions
6. Click a verification code to open the verify page
