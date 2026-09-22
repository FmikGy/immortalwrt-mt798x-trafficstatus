# Hardware-Offload Traffic Accounting

This fork adds per-client traffic accounting while MediaTek HNAT hardware
offload remains enabled. It targets the MT7981 and MT7986 platforms in this
tree.

## Why the kernel changes are required

Once a flow is offloaded to the PPE, most packets no longer traverse the
normal Linux forwarding path. Conntrack counters therefore stop representing
the complete flow, and userspace monitors that only read conntrack will
undercount traffic.

The HNAT changes read the PPE per-flow MIB counters and synchronize their
deltas into the matching conntrack accounting entry. Counter access is
serialized because the hardware MIB operation is read-and-clear. Accounting
state is also reset when a PPE entry is rebound so that counters from the
previous flow cannot leak into the new owner.

## Data path

1. MediaTek HNAT offloads an eligible flow to the PPE.
2. The HNAT keepalive path reads the PPE MIB and adds the unsynchronized delta
   to the corresponding conntrack direction.
3. `nlbwmon` polls conntrack every five seconds and stores per-host totals.
4. `/usr/libexec/trafficstatus-action snapshot` runs `nlbw` and returns JSON
   with the `mac`, `ip`, `conns`, `rx_bytes`, and `tx_bytes` columns.
5. The LuCI view merges IPv4 and IPv6 rows by MAC address, computes rates from
   a 15-second baseline, and retains a 15-minute in-browser chart window.

## Components

- `target/linux/mediatek/files-5.4/drivers/net/ethernet/mediatek/mtk_hnat/`
  contains the HNAT accounting synchronization and locking changes.
- `package/mtk/applications/nlbwmon/` packages nlbwmon 2025.06.02, licensed
  under ISC.
- `package/mtk/applications/luci-app-trafficstatus/` contains the LuCI view,
  RPC ACL, snapshot action, and Simplified Chinese translation.
- `defconfig/mt7981-*.config` and `defconfig/mt7986-*.config` enable HNAT,
  nlbwmon, the LuCI application, and its Chinese translation.

The LuCI page is available at `admin/network/usage`. The application package
depends on `nlbwmon`; it does not replace or disable hardware acceleration.

## Build

Choose the defconfig for the target device, regenerate the configuration, and
build the firmware normally. For example:

```sh
cp defconfig/mt7986-ax6000.config .config
make defconfig
make -j"$(nproc)"
```

The LuCI packages can be rebuilt independently during frontend development:

```sh
make package/mtk/applications/luci-app-trafficstatus/compile V=s -j1
```

Generated packages are written below `bin/packages/aarch64_cortex-a53/base/`.
Build output and local `.config` files are intentionally excluded from Git.

## Runtime behavior

- Snapshot polling interval: 5 seconds
- Rate baseline: 15 seconds
- Chart history: 15 minutes
- Address handling: IPv4 and IPv6 rows are merged when their MAC matches
- Counter reset handling: negative deltas are treated as zero
- Chart scale: minimum 1 Mbps, then rounded to 1/2/5 x 10^n steps

The backend JSON contract is intentionally small and stable:

```json
{
  "columns": ["mac", "ip", "conns", "rx_bytes", "tx_bytes"],
  "data": []
}
```

Additional columns may be returned. The frontend resolves fields by name and
does not depend on column order.

## Scope and limitations

- The kernel integration is for the MediaTek HNAT driver shipped by this
  repository.
- Qualcomm NSS and other vendor offload engines require different accounting
  hooks and are not included.
- The repository does not provide a compatibility alias for older local LuCI
  package names. Remove an older package before installing
  `luci-app-trafficstatus`.
- Accurate totals require conntrack accounting and per-flow HNAT accounting to
  remain enabled in the target kernel configuration.
