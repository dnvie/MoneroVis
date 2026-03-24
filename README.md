![logo](https://i.imgur.com/Kr9FHhX.jpeg)

MoneroVis is an interactive visual analytics platform developed as part of my Bachelor's thesis at TU Wien.  
It is designed to explore and trace activity within Monero's privacy-preserving blockchain, transforming opaque protocol data into interactive visual structures for analysis and exploration.

The platform combines live network monitoring, transaction visualization, and forward-tracing analytics to help users understand how outputs propagate and are reused across the blockchain.

---

The stand-out features of MoneroVis are the Decoy Map and the automated poisoned outputs tracing.

## Decoy Map

The Decoy Map is the core analytical component of MoneroVis.

It is a scalable force-directed graph that maps the forward lineage of a specific output, showing every transaction in which that output later appears as a ring member (decoy).

This allows users to observe how outputs propagate through the network over time and identify reuse patterns that are difficult to detect using standard node queries.

The Decoy Map can be opened by clicking on a transaction output, either from the transaction graph view or from the tabular transaction interface.

Since a standard Monero node cannot provide information about which future transactions reference a specific output as a ring member, this feature requires a custom database with optimized indices.
![decoy_map_reduced](https://i.imgur.com/rgqM7D1.jpeg)

---

## Poisoned Outputs Tracing

MoneroVis also includes an automated tracing tool for investigating the Poisoned Outputs (or EAE) attack.

Users can provide a list of suspicious transaction hashes. The system then:

- recursively traces referenced outputs  
- detects consolidation points where outputs intersect  
- automatically constructs a multi-hop tracking tree

This makes it possible to visualize how potentially compromised outputs propagate and where they converge.

A real-world example of this attack is documented here:  
https://medium.com/@nbax/tracing-the-wannacry-2-0-monero-transactions-d8c1e5129dc1

To reproduce the example from the article using MoneroVis, paste the following transaction hashes into the sidebar:
```
390ddca76740f82f6c93a3e92ab03a31c0f04827f27cec3cd96c1f5782c97395,
c8b66788112d53c069eac4d9e28045dc8f92c712d2945ce224c5cd27457f8e35,
dbb2efd7f5122f430cabdce6cabbb46b9ad59b5753d8eebb8ec7bf60004625f2,
a6ebd8cbba75153786e8d4ff471df1003e0d047afe84f1eba056bd42b1f7afb5,
235f32038361b8f315333025b6d1b92c18c0c7d24a424613cf299bd982b518dc,
a13c79f12eb2571539d2c9f24fff7a04bff220d444ef534ead441eaeb8cf17a6,
52daba8dbabe98665456975fa5f95b2095d08d857710e0aa02d6ed41d8106aed,
dc377ded419889838a23472ff399c0f4c5ab45b1352d9a1ed34491cfd61c55fc
```
![tracing_auto](https://i.imgur.com/sROPdT4.jpeg)

---

Besides standard block explorer functionality such as tabular listings of the mempool, blocks, and transactions, MoneroVis introduces dedicated visualizations for each of these components.
### Mempool Visualization:
![mempool](https://i.imgur.com/OYITeqL.jpeg)

### Blocks Visualization:
![blocks](https://i.imgur.com/LJoVNYP.jpeg)

### Block Visualization:
![block](https://i.imgur.com/6V6vqgy.jpeg)

### Transaction Visualization:
![tx_graph](https://i.imgur.com/6EHuYHH.jpeg)
![tx_ring](https://i.imgur.com/H3nhwFE.jpeg)

---
## Architecture:
MoneroVis is implemented as a small microservice-based system consisting of a frontend visualization client, backend API services connected to a Monero node, a WebSocket service that streams live mempool events to the interface, and a data generation pipeline that continuously builds a forward index of blockchain outputs. This architecture enables both real-time network monitoring and the forward-looking queries required for the Decoy Map and automated poisoned outputs tracing.

![diagram](https://i.imgur.com/YzNK3Ig.jpeg)

## Run MoneroVis locally:
### Prerequisites:
- Go 1.26
- Angular 20.3+
- Access to an unrestricted Monero Node with ZMQ enabled (ideally a local full-node)

Before running locally, update hardcoded addresses where needed.

### Backend config

Edit `backend/data/constants.go`:

- `Node` (Monero node RPC)
- `DecoyApiUrl` (decoy API base)
- `DatagenBaseURL` (datagen API base)

### Datagen RPC URLs

These are currently hardcoded in code paths and should be set to your node RPC URL:

- `datagen/outputs/outputs.go`
- `datagen/inputs/inputs.go`
- `datagen/webserver/main.go`

### Coinbase tracker placeholders

Set these in `datagen/coinbase/coinbase.go`:

- `moneroNodeBaseURL`
- `wsURL`

### WebSocket ZMQ source

Set `MoneroZmqAddr` in `websocket/websocket.go` to your node ZMQ endpoint (`tcp://...`).

### Frontend API targets

Frontend services currently point to production domains. For local deployment, update:

- `frontend/MoneroVis/src/app/service/home.service.ts`
- `frontend/MoneroVis/src/app/service/block.service.ts`
- `frontend/MoneroVis/src/app/service/transaction.service.ts`
- `frontend/MoneroVis/src/app/service/search.service.ts`
- `frontend/MoneroVis/src/app/service/decoy.service.ts`
- `frontend/MoneroVis/src/app/service/clipboard.service.ts`
- `frontend/MoneroVis/src/app/components/home/home.ts` (WebSocket URL)

### Populate the Database (datagen)

From `datagen`, run:

- one-time generation: `go run . generate`
- periodic generation: `go run . autogen <minutes>`
- coinbase tracker: `go run . coinbase`

The SQLite database is stored at `datagen/database/monero.db`.

> Please note that, depending on the hardware used, this process might take a few days.
> Also make sure at least 200GB of storage space are available for the database file.

### Pi vs PC Mode (`pi` flag)

`datagen` supports an optional trailing `pi` argument:

- `go run . generate pi`
- `go run . autogen 10 pi`
- `go run . coinbase pi`

What it does:

- switches SQLite PRAGMA tuning to Raspberry Pi-safe/conservative settings
- avoids the heavier post-processing gap scan done in non-`pi` mode

Use:

- **without `pi`** on desktop/server hardware (higher performance)
- **with `pi`** on constrained devices (safer memory/IO profile)

### Start the Services

#### Start datagen API (`:8081`)

From `datagen`: `go run ./webserver`

#### Start backend API (`:8080`)

From `backend`: `go run .`

#### Start websocket service (`:8085`)

From `websocket`: `go run .`

#### Start frontend (`:4200` in dev)

From `frontend/MoneroVis/src`:

- install deps: `npm install`
- run dev server: `ng serve`

---
