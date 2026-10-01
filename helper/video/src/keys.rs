// keys.rs -- EnotDesk protocol key names -> Windows virtual-key codes.
//
// The name set mirrors INPUT_KEYS in client/lib/protocol.mjs exactly (the
// browser/renderer side validates against that allowlist; this helper maps the
// same names). If the allowlist ever changes there, change this table too --
// the i18n/parity contract test does not cover this file.
//
// Key codes are returned as raw u8 values (the VK_ numbers) so this module
// stays pure Rust with zero Win32 imports; win.rs wraps them in VIRTUAL_KEY.
//
// `extended` marks keys that require KEYEVENTF_EXTENDEDKEY so applications see
// them as navigation keys instead of their grey-numpad twins (without the flag
// VK_UP types '8', VK_HOME types '7', and so on). The flag must be set on both
// the down and the up event.

pub fn key_vk(name: &str) -> Option<(u8, bool)> {
    let k = name.to_ascii_lowercase();

    // Single-character names: letters, digits, and the punctuation members of
    // INPUT_KEYS. OEM codes are US-layout physical positions (the operator's
    // web event already went through a physical-code map on the host side).
    if k.len() == 1 {
        let c = k.as_bytes()[0];
        if c.is_ascii_lowercase() {
            // 'a'..'z' -> VK_A (0x41)..VK_Z (0x5A).
            return Some((c - b'a' + 0x41, false));
        }
        if c.is_ascii_digit() {
            // '0'..'9' -> VK_0 (0x30)..VK_9 (0x39).
            return Some((c - b'0' + 0x30, false));
        }
        return match c {
            b'-' => Some((0xBD, false)),  // VK_OEM_MINUS
            b'=' => Some((0xBB, false)),  // VK_OEM_PLUS ('=' key, '+' shifted)
            b'.' => Some((0xBE, false)),  // VK_OEM_PERIOD
            b',' => Some((0xBC, false)),  // VK_OEM_COMMA
            b'/' => Some((0xBF, false)),  // VK_OEM_2
            b';' => Some((0xBA, false)),  // VK_OEM_1
            b'\'' => Some((0xDE, false)), // VK_OEM_7
            b'[' => Some((0xDB, false)),  // VK_OEM_4
            b']' => Some((0xDD, false)),  // VK_OEM_6
            b'\\' => Some((0xDC, false)), // VK_OEM_5
            b'`' => Some((0xC0, false)),  // VK_OEM_3
            _ => None,
        };
    }

    // Multi-character names from INPUT_KEYS.
    let (vk, ext) = match k.as_str() {
        "space" => (0x20, false),     // VK_SPACE
        "enter" => (0x0D, false),     // VK_RETURN
        "tab" => (0x09, false),       // VK_TAB
        "escape" => (0x1B, false),    // VK_ESCAPE
        "backspace" => (0x08, false), // VK_BACK
        "delete" => (0x2E, true),     // VK_DELETE (extended)
        "arrowup" => (0x26, true),    // VK_UP
        "arrowdown" => (0x28, true),  // VK_DOWN
        "arrowleft" => (0x25, true),  // VK_LEFT
        "arrowright" => (0x27, true), // VK_RIGHT
        "home" => (0x24, true),       // VK_HOME
        "end" => (0x23, true),        // VK_END
        "pageup" => (0x21, true),     // VK_PRIOR
        "pagedown" => (0x22, true),   // VK_NEXT
        "shift" => (0x10, false),     // VK_SHIFT (generic)
        "control" => (0x11, false),   // VK_CONTROL (generic)
        "alt" => (0x12, false),       // VK_MENU
        // Protocol has one "meta"; we send the LEFT Windows key (0x5B). The
        // right key (0x5C) would need the extended flag and behaves identically.
        "meta" => (0x5B, false), // VK_LWIN
        _ => return None,
    };
    Some((vk, ext))
}
