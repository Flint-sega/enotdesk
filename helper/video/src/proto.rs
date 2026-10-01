// proto.rs -- pipe wire framing and the tiny JSON subset used on the pipe.
// No external crates: the payload vocabulary is known and small, so a minimal
// parser/serializer replaces serde (repo rule: no new dependencies).

// Binary message layout, both directions:
//   [u32 LE magic][u8 type][u32 LE payload length][payload]
pub const MAGIC: u32 = 0x454E_4F54; // "ENOT"

// Message types. 0 and 3 travel service -> helper; 1 and 2 helper -> service.
pub const T_HELLO: u8 = 0; // payload: one-time token (UTF-8), first message only
pub const T_FRAME: u8 = 1; // payload: JPEG bytes of one frame
pub const T_STATUS: u8 = 2; // payload: JSON status document (every 2 s)
pub const T_CMD: u8 = 3; // payload: JSON command document

/// Build one framed message (header + payload in a single buffer so the
/// service reads it without torn reads on the byte-mode pipe).
pub fn encode_msg(ty: u8, payload: &[u8]) -> Vec<u8> {
    let mut m = Vec::with_capacity(9 + payload.len());
    m.extend_from_slice(&MAGIC.to_le_bytes());
    m.push(ty);
    m.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    m.extend_from_slice(payload);
    m
}

// ---------------------------------------------------------------------------
// Minimal JSON: objects, arrays, strings, numbers, booleans, null. Enough for
// the command documents the Node service emits and nothing more.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_num(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }
}

/// Parse a complete JSON document. Trailing garbage is an error.
pub fn parse(src: &str) -> Result<Json, String> {
    let mut p = Parser {
        b: src.as_bytes(),
        i: 0,
        depth: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err("trailing characters after JSON value".into());
    }
    Ok(v)
}

/// Escape a string for embedding inside a JSON string literal. Output is pure
/// ASCII: anything outside printable 0x20..=0x7E becomes a \\uXXXX escape.
pub fn jstr(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        let u = c as u32;
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ if u < 0x20 || u > 0x7E => out.push_str(&format!("\\u{u:04x}")),
            _ => out.push(c),
        }
    }
    out
}

const MAX_DEPTH: u32 = 16; // command documents are flat; deep nesting is garbage

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
    depth: u32,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.i += 1;
        }
    }

    fn expect(&mut self, c: u8) -> Result<(), String> {
        if self.peek() == Some(c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected '{}' at byte {}", c as char, self.i))
        }
    }

    fn value(&mut self) -> Result<Json, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err("JSON nesting too deep".into());
        }
        let v = match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Json::Str),
            Some(b't') => self.lit("true", Json::Bool(true)),
            Some(b'f') => self.lit("false", Json::Bool(false)),
            Some(b'n') => self.lit("null", Json::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number().map(Json::Num),
            _ => Err("unexpected character".into()),
        };
        self.depth -= 1;
        v
    }

    fn lit(&mut self, word: &str, v: Json) -> Result<Json, String> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("bad literal near byte {}", self.i))
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.expect(b'{')?;
        let mut pairs = Vec::new();
        self.ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Json::Obj(pairs));
        }
        loop {
            self.ws();
            let k = self.string()?;
            self.ws();
            self.expect(b':')?;
            self.ws();
            let v = self.value()?;
            pairs.push((k, v));
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(pairs));
                }
                _ => return Err("expected ',' or '}' in object".into()),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            match self.peek() {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err("expected ',' or ']' in array".into()),
            }
        }
    }

    fn string(&mut self) -> Result<String, String> {
        self.expect(b'"')?;
        let mut out = String::new();
        loop {
            match self.peek() {
                None => return Err("unterminated string".into()),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let esc = self.peek().ok_or("unterminated escape")?;
                    self.i += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let cp = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&cp) {
                                // Surrogate pair: must be followed by \uDCxx..\uDFFF.
                                if self.peek() == Some(b'\\') {
                                    self.i += 1;
                                    if self.peek() != Some(b'u') {
                                        return Err("bad surrogate pair".into());
                                    }
                                    self.i += 1;
                                    let lo = self.hex4()?;
                                    if !(0xDC00..0xE000).contains(&lo) {
                                        return Err("bad surrogate pair".into());
                                    }
                                    let c = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                                    char::from_u32(c).ok_or("bad surrogate pair")?
                                } else {
                                    return Err("lone surrogate".into());
                                }
                            } else {
                                char::from_u32(cp).ok_or("bad \\u escape")?
                            };
                            out.push(ch);
                        }
                        _ => return Err("bad escape".into()),
                    }
                }
                Some(c) if c < 0x20 => return Err("control character in string".into()),
                Some(c) => {
                    // Input comes from a &str (valid UTF-8); consume one full
                    // sequence using the leading byte's length.
                    let len = utf8_len(c);
                    let end = self.i + len;
                    if end > self.b.len() {
                        return Err("truncated UTF-8 in string".into());
                    }
                    let s = std::str::from_utf8(&self.b[self.i..end]).map_err(|_| "bad utf8")?;
                    out.push_str(s);
                    self.i = end;
                }
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, String> {
        if self.i + 4 > self.b.len() {
            return Err("truncated \\u escape".into());
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4]).map_err(|_| "bad \\u escape")?;
        let v = u32::from_str_radix(s, 16).map_err(|_| "bad \\u escape")?;
        self.i += 4;
        Ok(v)
    }

    fn number(&mut self) -> Result<f64, String> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-'))
        {
            self.i += 1;
        }
        std::str::from_utf8(&self.b[start..self.i])
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .ok_or_else(|| "bad number".into())
    }
}

fn utf8_len(lead: u8) -> usize {
    if lead < 0x80 {
        1
    } else if lead < 0xE0 {
        2
    } else if lead < 0xF0 {
        3
    } else {
        4
    }
}
