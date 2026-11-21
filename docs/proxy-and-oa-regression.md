# Proxy connection reuse and OA fixture isolation

The web proxy uses an HTTP/1.1 upstream pool for normal API calls and attachment streaming. Idle connections expire after four seconds, below the Node HTTP server's default idle keepalive timeout. Docker DNS is resolved again every five seconds so an API replacement can change address without restarting the web container. Keep the upstream zone and Docker resolver together; a static startup-only address can strand the proxy after recreation.

`tests/integration/proxy-keepalive.mjs` runs only in disposable CI. It sends 4,000 requests across both proxy locations and measures actual upstream TCP connections at a fixture server. It then occupies the former API address, starts a replacement at a different address and requires both routes to recover. It creates a separate network and removes only its own containers.

OA maintenance executes even when live provider dispatch is disabled. It locks active approval rows with `FOR UPDATE SKIP LOCKED`; the dispatcher can legitimately return false while another transaction owns the only due row. A fixture that directly dispatches a chosen approval must exclusively own that queue. The OA integration wrapper stops the background worker, runs a separate one-shot worker container and restores the worker in `finally`. Production queue and expiry rules are unchanged.

The integration runner explicitly holds an approval lock, verifies dispatch returns false without mutating the intent, releases the lock and requires the same intent to dispatch successfully. Unexpected missing work now reports the target state, lease, deadline and database wait metadata. This validates the lock mechanism; historical failures without captured database lock evidence cannot retrospectively identify the exact lock holder.

After release, repeat the original unpaced read stages and bounded reproduction, then run at least 30 minutes at the previous paced authenticated workload. Record response failures, percentiles, upstream TCP states, CPU, memory and readiness. Keep original failure evidence separately. Synthetic OA acceptance does not establish real DingTalk provider acceptance.
