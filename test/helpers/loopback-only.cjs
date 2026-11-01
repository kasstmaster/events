// Test-only fallback for containers whose OS cannot enumerate network interfaces.
// The suite binds explicitly to loopback; no network permissions are changed.
const os = require("node:os");
const original = os.networkInterfaces;
os.networkInterfaces = function () {
  try {
    return original();
  } catch (error) {
    if (!String(error.message).includes("uv_interface_addresses")) throw error;
    return {
      lo: [
        {
          address: "127.0.0.1",
          netmask: "255.0.0.0",
          family: "IPv4",
          mac: "00:00:00:00:00:00",
          internal: true,
          cidr: "127.0.0.1/8",
        },
      ],
    };
  }
};
require("node:module").syncBuiltinESMExports();
