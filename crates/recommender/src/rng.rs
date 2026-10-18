//! numpy's `np.random.default_rng(seed)` draws, bit for bit: SeedSequence
//! entropy mixing, PCG64 (rand_pcg's Lcg128Xsl64 is the same LCG and XSL-RR
//! output), PCG64's 32-bit half-word carry, the 32-bit Lemire bounded integers
//! and `Generator.choice`. The ranker's model subsample and k-means seeding
//! draw through this, so a Rust fit picks the same rows as the Python one.
//! Only populations below 2^32 are supported (numpy switches to 64-bit draws
//! above that; no catalog comes close).

use rand_pcg::Lcg128Xsl64;
use rand_pcg::rand_core::Rng;

const INIT_A: u32 = 0x43b0_d7e5;
const MULT_A: u32 = 0x931e_8875;
const INIT_B: u32 = 0x8b51_f9dd;
const MULT_B: u32 = 0x58f3_8ded;
const MIX_MULT_L: u32 = 0xca01_f9dd;
const MIX_MULT_R: u32 = 0x4973_f715;
const XSHIFT: u32 = 16;
const POOL_SIZE: usize = 4;

/// `SeedSequence(seed).generate_state(4, np.uint64)`.
pub fn seed_sequence_state(seed: u128) -> [u64; 4] {
    // _int_to_uint32_array: little-endian 32-bit words, [0] for zero.
    let mut entropy = Vec::new();
    let mut n = seed;
    loop {
        entropy.push(n as u32);
        n >>= 32;
        if n == 0 {
            break;
        }
    }
    let mut hash_const = INIT_A;
    let mut hashmix = |value: u32| {
        let mut v = value ^ hash_const;
        hash_const = hash_const.wrapping_mul(MULT_A);
        v = v.wrapping_mul(hash_const);
        v ^ (v >> XSHIFT)
    };
    let mix = |x: u32, y: u32| {
        let r = MIX_MULT_L
            .wrapping_mul(x)
            .wrapping_sub(MIX_MULT_R.wrapping_mul(y));
        r ^ (r >> XSHIFT)
    };
    let mut pool = [0u32; POOL_SIZE];
    for (i, p) in pool.iter_mut().enumerate() {
        *p = hashmix(entropy.get(i).copied().unwrap_or(0));
    }
    for src in 0..POOL_SIZE {
        for dst in 0..POOL_SIZE {
            if src != dst {
                pool[dst] = mix(pool[dst], hashmix(pool[src]));
            }
        }
    }
    for &e in entropy.iter().skip(POOL_SIZE) {
        for p in pool.iter_mut() {
            *p = mix(*p, hashmix(e));
        }
    }
    let mut hash_const = INIT_B;
    let mut words = [0u32; 8];
    for (i, w) in words.iter_mut().enumerate() {
        let mut v = pool[i % POOL_SIZE] ^ hash_const;
        hash_const = hash_const.wrapping_mul(MULT_B);
        v = v.wrapping_mul(hash_const);
        *w = v ^ (v >> XSHIFT);
    }
    std::array::from_fn(|i| u64::from(words[2 * i]) | (u64::from(words[2 * i + 1]) << 32))
}

/// `np.random.default_rng(seed)`: PCG64 over a SeedSequence.
pub struct Generator {
    pcg: Lcg128Xsl64,
    /// PCG64 hands out a 64-bit word as two 32-bit draws, low half first.
    half: Option<u32>,
}

impl Generator {
    pub fn new(seed: u128) -> Self {
        let s = seed_sequence_state(seed);
        let state = (u128::from(s[0]) << 64) | u128::from(s[1]);
        let stream = (u128::from(s[2]) << 64) | u128::from(s[3]);
        Self {
            pcg: Lcg128Xsl64::new(state, stream),
            half: None,
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.pcg.next_u64()
    }

    fn next_u32(&mut self) -> u32 {
        if let Some(h) = self.half.take() {
            return h;
        }
        let w = self.next_u64();
        self.half = Some((w >> 32) as u32);
        w as u32
    }

    /// A uniform integer in [0, rng] (numpy's random_bounded_uint64 with
    /// use_masked false, 32-bit branch: Lemire's multiply-shift rejection).
    fn bounded(&mut self, rng: u64) -> u64 {
        if rng == 0 {
            return 0;
        }
        assert!(
            rng < u64::from(u32::MAX),
            "population too large for 32-bit draws"
        );
        let excl = rng as u32 + 1;
        let mut m = u64::from(self.next_u32()) * u64::from(excl);
        if (m as u32) < excl {
            let threshold = (u32::MAX - rng as u32) % excl;
            while (m as u32) < threshold {
                m = u64::from(self.next_u32()) * u64::from(excl);
            }
        }
        m >> 32
    }

    /// `integers(0, high, size)`.
    pub fn integers(&mut self, high: u64, size: usize) -> Vec<u64> {
        assert!(high > 0, "high <= 0");
        (0..size).map(|_| self.bounded(high - 1)).collect()
    }

    /// `choice(pop, size, replace=True)`: indices into a population of `pop`.
    pub fn choice_replace(&mut self, pop: usize, size: usize) -> Vec<usize> {
        self.integers(pop as u64, size)
            .into_iter()
            .map(|v| v as usize)
            .collect()
    }

    /// `choice(pop, size, replace=False)` (shuffle=True), as indices.
    pub fn choice(&mut self, pop: usize, size: usize) -> Vec<usize> {
        assert!(
            size <= pop,
            "Cannot take a larger sample than population when replace is False"
        );
        if pop > 10_000 && size > pop / 50 {
            // Tail shuffle: Fisher-Yates over the last `size` slots only.
            let mut idx: Vec<usize> = (0..pop).collect();
            self.shuffle_from(&mut idx, (pop - size).max(1));
            return idx.split_off(pop - size);
        }
        // Floyd's algorithm over an open-addressed hash set, then shuffled.
        let mask = gen_mask((1.2 * size as f64) as u64);
        let mut set = vec![u64::MAX; (mask + 1) as usize];
        let mut out = vec![0usize; size];
        for j in (pop - size)..pop {
            let val = self.bounded(j as u64);
            let mut loc = (val & mask) as usize;
            while set[loc] != u64::MAX && set[loc] != val {
                loc = (loc + 1) & mask as usize;
            }
            let pick = if set[loc] == u64::MAX {
                set[loc] = val;
                val
            } else {
                let mut loc = (j as u64 & mask) as usize;
                while set[loc] != u64::MAX {
                    loc = (loc + 1) & mask as usize;
                }
                set[loc] = j as u64;
                j as u64
            };
            out[j + size - pop] = pick as usize;
        }
        self.shuffle_from(&mut out, 1);
        out
    }

    /// numpy's _shuffle_int: swap each slot from the end down to `first`
    /// with a uniform earlier-or-same slot.
    fn shuffle_from(&mut self, data: &mut [usize], first: usize) {
        for i in (first..data.len()).rev() {
            let j = self.bounded(i as u64) as usize;
            data.swap(i, j);
        }
    }
}

/// The smallest all-ones mask covering `max`.
fn gen_mask(max: u64) -> u64 {
    let mut m = max;
    for s in [1, 2, 4, 8, 16, 32] {
        m |= m >> s;
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn num(v: &Value) -> u128 {
        v.as_str().unwrap().parse().unwrap()
    }

    fn arg(op: &[Value], i: usize) -> usize {
        op[i].as_u64().unwrap() as usize
    }

    /// tests/fixtures/rng-goldens.json, recorded from numpy by gen_rng_goldens.py.
    #[test]
    fn matches_numpy_draws() {
        let g: Value =
            serde_json::from_str(include_str!("../tests/fixtures/rng-goldens.json")).unwrap();
        for case in g["cases"].as_array().unwrap() {
            let seed = num(&case["seed"]);
            let state: Vec<u64> = case["state"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| num(v) as u64)
                .collect();
            assert_eq!(
                seed_sequence_state(seed).to_vec(),
                state,
                "seed {seed}: state"
            );
            let mut twin = Generator::new(seed);
            for (i, w) in case["raw"].as_array().unwrap().iter().enumerate() {
                assert_eq!(u128::from(twin.next_u64()), num(w), "seed {seed}: raw {i}");
            }
            let mut rng = Generator::new(seed);
            for d in case["draws"].as_array().unwrap() {
                let op = d["op"].as_array().unwrap();
                let got: Vec<u64> = match op[0].as_str().unwrap() {
                    "integers" => rng.integers(arg(op, 1) as u64, arg(op, 2)),
                    "choice" if op[3] == true => rng
                        .choice_replace(arg(op, 1), arg(op, 2))
                        .into_iter()
                        .map(|v| v as u64)
                        .collect(),
                    "choice" => rng
                        .choice(arg(op, 1), arg(op, 2))
                        .into_iter()
                        .map(|v| v as u64)
                        .collect(),
                    _ => {
                        let (start, step, n, size) =
                            (arg(op, 1), arg(op, 2), arg(op, 3), arg(op, 4));
                        let pop: Vec<usize> = (0..n).map(|i| i * step + start).collect();
                        rng.choice(n, size)
                            .into_iter()
                            .map(|i| pop[i] as u64)
                            .collect()
                    }
                };
                let want: Vec<u64> = d["out"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .collect();
                assert_eq!(got, want, "seed {seed}: {op:?}");
            }
        }
    }
}
