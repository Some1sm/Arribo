package main

// Port of the fdlibm routines V8 uses for Math.sin, Math.cos, Math.atan2 and
// Math.exp (v8/src/base/ieee754.cc, itself from FreeBSD msun / fdlibm 5.3).
// Go's math package computes these differently and disagrees in the last
// bit for a few percent of inputs, which changes distances and rounded
// metres. The operation order below is kept exactly as in the C source.

import "math"

func hiWord(x float64) int32  { return int32(math.Float64bits(x) >> 32) }
func loWord(x float64) uint32 { return uint32(math.Float64bits(x)) }
func fromWords(hi int32, lo uint32) float64 {
	return math.Float64frombits(uint64(uint32(hi))<<32 | uint64(lo))
}

// ---------------------------------------------------------------- atan

var atanhi = [4]float64{
	4.63647609000806093515e-01, // atan(0.5)hi 0x3FDDAC67, 0x0561BB4F
	7.85398163397448278999e-01, // atan(1.0)hi 0x3FE921FB, 0x54442D18
	9.82793723247329054082e-01, // atan(1.5)hi 0x3FEF730B, 0xD281F69B
	1.57079632679489655800e+00, // atan(inf)hi 0x3FF921FB, 0x54442D18
}

var atanlo = [4]float64{
	2.26987774529616870924e-17, // atan(0.5)lo 0x3C7A2B7F, 0x222F65E2
	3.06161699786838301793e-17, // atan(1.0)lo 0x3C81A626, 0x33145C07
	1.39033110312309984516e-17, // atan(1.5)lo 0x3C700788, 0x7AF0CBBD
	6.12323399573676603587e-17, // atan(inf)lo 0x3C91A626, 0x33145C07
}

var aT = [11]float64{
	3.33333333333329318027e-01,  // 0x3FD55555, 0x5555550D
	-1.99999999998764832476e-01, // 0xBFC99999, 0x9998EBC4
	1.42857142725034663711e-01,  // 0x3FC24924, 0x920083FF
	-1.11111104054623557880e-01, // 0xBFBC71C6, 0xFE231671
	9.09088713343650656196e-02,  // 0x3FB745CD, 0xC54C206E
	-7.69187620504482999495e-02, // 0xBFB3B0F2, 0xAF749A6D
	6.66107313738753120669e-02,  // 0x3FB10D66, 0xA0D03D51
	-5.83357013379057348645e-02, // 0xBFADDE2D, 0x52DEFD9A
	4.97687799461593236017e-02,  // 0x3FA97B4B, 0x24760DEB
	-3.65315727442169155270e-02, // 0xBFA2B444, 0x2C6A6C2F
	1.62858201153657823623e-02,  // 0x3F90AD3A, 0xE322DA11
}

func fdAtan(x float64) float64 {
	hx := hiWord(x)
	ix := hx & 0x7fffffff
	var id int
	if ix >= 0x44100000 { // |x| >= 2^66
		low := loWord(x)
		if ix > 0x7ff00000 || (ix == 0x7ff00000 && low != 0) {
			return x + x // NaN
		}
		if hx > 0 {
			return atanhi[3] + atanlo[3]
		}
		return -atanhi[3] - atanlo[3]
	}
	if ix < 0x3fdc0000 { // |x| < 0.4375
		if ix < 0x3e400000 { // |x| < 2^-27
			return x
		}
		id = -1
	} else {
		x = math.Abs(x)
		if ix < 0x3ff30000 { // |x| < 1.1875
			if ix < 0x3fe60000 { // 7/16 <= |x| < 11/16
				id = 0
				x = (2.0*x - 1.0) / (2.0 + x)
			} else { // 11/16 <= |x| < 19/16
				id = 1
				x = (x - 1.0) / (x + 1.0)
			}
		} else {
			if ix < 0x40038000 { // |x| < 2.4375
				id = 2
				x = (x - 1.5) / (1.0 + 1.5*x)
			} else { // 2.4375 <= |x| < 2^66
				id = 3
				x = -1.0 / x
			}
		}
	}
	z := x * x
	w := z * z
	s1 := z * (aT[0] + w*(aT[2]+w*(aT[4]+w*(aT[6]+w*(aT[8]+w*aT[10])))))
	s2 := w * (aT[1] + w*(aT[3]+w*(aT[5]+w*(aT[7]+w*aT[9]))))
	if id < 0 {
		return x - x*(s1+s2)
	}
	z = atanhi[id] - ((x*(s1+s2) - atanlo[id]) - x)
	if hx < 0 {
		return -z
	}
	return z
}

const (
	fdPiO4 = 7.8539816339744827900e-01 // 0x3FE921FB, 0x54442D18
	fdPiO2 = 1.5707963267948965580e+00 // 0x3FF921FB, 0x54442D18
	fdPi   = 3.1415926535897931160e+00 // 0x400921FB, 0x54442D18
	fdPiLo = 1.2246467991473531772e-16 // 0x3CA1A626, 0x33145C07
)

func fdAtan2(y, x float64) float64 {
	hx := hiWord(x)
	lx := loWord(x)
	ix := hx & 0x7fffffff
	hy := hiWord(y)
	ly := loWord(y)
	iy := hy & 0x7fffffff
	if math.IsNaN(x) || math.IsNaN(y) {
		return x + y
	}
	if hx == 0x3ff00000 && lx == 0 { // x == 1.0
		return fdAtan(y)
	}
	m := int((hy>>31)&1) | int((hx>>30)&2) // 2*sign(x)+sign(y)

	if iy == 0 && ly == 0 { // y == 0
		switch m {
		case 0, 1:
			return y
		case 2:
			return fdPi
		default:
			return -fdPi
		}
	}
	if ix == 0 && lx == 0 { // x == 0
		if hy < 0 {
			return -fdPiO2
		}
		return fdPiO2
	}
	if ix == 0x7ff00000 { // x is INF
		if iy == 0x7ff00000 {
			switch m {
			case 0:
				return fdPiO4
			case 1:
				return -fdPiO4
			case 2:
				return 3.0 * fdPiO4
			default:
				return -3.0 * fdPiO4
			}
		}
		switch m {
		case 0:
			return 0
		case 1:
			return math.Copysign(0, -1)
		case 2:
			return fdPi
		default:
			return -fdPi
		}
	}
	if iy == 0x7ff00000 { // y is INF
		if hy < 0 {
			return -fdPiO2
		}
		return fdPiO2
	}
	var z float64
	k := (iy - ix) >> 20
	if k > 60 { // |y/x| > 2^60
		z = fdPiO2 + 0.5*fdPiLo
		m &= 1
	} else if hx < 0 && k < -60 { // 0 > |y|/x > -2^-60
		z = 0.0
	} else {
		z = fdAtan(math.Abs(y / x))
	}
	switch m {
	case 0:
		return z
	case 1:
		return -z
	case 2:
		return fdPi - (z - fdPiLo)
	default:
		return (z - fdPiLo) - fdPi
	}
}

// ---------------------------------------------------------------- exp

const (
	expOThreshold = 7.09782712893383973096e+02  // 0x40862E42, 0xFEFA39EF
	expUThreshold = -7.45133219101941108420e+02 // 0xc0874910, 0xD52D3051
	expInvLn2     = 1.44269504088896338700e+00  // 0x3ff71547, 0x652b82fe
	expP1         = 1.66666666666666019037e-01  // 0x3FC55555, 0x5555553E
	expP2         = -2.77777777770155933842e-03 // 0xBF66C16C, 0x16BEBD93
	expP3         = 6.61375632143793436117e-05  // 0x3F11566A, 0xAF25DE2C
	expP4         = -1.65339022054652515390e-06 // 0xBEBBBD41, 0xC5D26BF1
	expP5         = 4.13813679705723846039e-08  // 0x3E663769, 0x72BEA4D0
	expE          = 2.718281828459045           // 0x4005bf0a, 0x8b145769
	expTwom1000   = 9.33263618503218878990e-302 // 2^-1000
)

var (
	expHalF  = [2]float64{0.5, -0.5}
	expLn2HI = [2]float64{6.93147180369123816490e-01, -6.93147180369123816490e-01} // 0x3fe62e42, 0xfee00000
	expLn2LO = [2]float64{1.90821492927058770002e-10, -1.90821492927058770002e-10} // 0x3dea39ef, 0x35793c76
)

func fdExp(x float64) float64 {
	var hi, lo, c, t, twopk, y float64
	k := int32(0)
	hx := uint32(hiWord(x))
	xsb := int((hx >> 31) & 1)
	hx &= 0x7fffffff

	if hx >= 0x40862E42 { // |x| >= 709.78...
		if hx >= 0x7ff00000 {
			lx := loWord(x)
			if (hx&0xfffff)|lx != 0 {
				return x + x // NaN
			}
			if xsb == 0 {
				return x
			}
			return 0.0
		}
		if x > expOThreshold {
			return math.Inf(1)
		}
		if x < expUThreshold {
			return 0
		}
	}

	if hx > 0x3fd62e42 { // |x| > 0.5 ln2
		if hx < 0x3FF0A2B2 { // and |x| < 1.5 ln2
			if x == 1.0 {
				return expE
			}
			hi = x - expLn2HI[xsb]
			lo = expLn2LO[xsb]
			k = int32(1 - xsb - xsb)
		} else {
			k = int32(expInvLn2*x + expHalF[xsb])
			t = float64(k)
			hi = x - t*expLn2HI[0] // t*ln2HI is exact here
			lo = t * expLn2LO[0]
		}
		x = hi - lo
	} else if hx < 0x3e300000 { // |x| < 2^-28
		return 1.0 + x
	} else {
		k = 0
	}

	t = x * x
	if k >= -1021 {
		twopk = fromWords(0x3ff00000+(k<<20), 0)
	} else {
		twopk = fromWords(0x3ff00000+((k+1000)<<20), 0)
	}
	c = x - t*(expP1+t*(expP2+t*(expP3+t*(expP4+t*expP5))))
	if k == 0 {
		return 1.0 - ((x*c)/(c-2.0) - x)
	}
	y = 1.0 - ((lo - (x*c)/(2.0-c)) - hi)
	if k >= -1021 {
		if k == 1024 {
			return y * 2.0 * 0x1p1023
		}
		return y * twopk
	}
	return y * twopk * expTwom1000
}

// ---------------------------------------------------------------- sin / cos

const (
	ksHalf = 5.00000000000000000000e-01
	ksS1   = -1.66666666666666324348e-01 // 0xBFC55555, 0x55555549
	ksS2   = 8.33333333332248946124e-03  // 0x3F811111, 0x1110F8A6
	ksS3   = -1.98412698298579493134e-04 // 0xBF2A01A0, 0x19C161D5
	ksS4   = 2.75573137070700676789e-06  // 0x3EC71DE3, 0x57B1FE7D
	ksS5   = -2.50507602534068634195e-08 // 0xBE5AE5E6, 0x8A2B9CEB
	ksS6   = 1.58969099521155010221e-10  // 0x3DE5D93A, 0x5ACFD57C

	kcC1 = 4.16666666666666019037e-02  // 0x3FA55555, 0x5555554C
	kcC2 = -1.38888888888741095749e-03 // 0xBF56C16C, 0x16C15177
	kcC3 = 2.48015872894767294178e-05  // 0x3EFA01A0, 0x19CB1590
	kcC4 = -2.75573143513906633035e-07 // 0xBE927E4F, 0x809C52AD
	kcC5 = 2.08757232129817482790e-09  // 0x3E21EE9E, 0xBDB4B1C4
	kcC6 = -1.13596475577881948265e-11 // 0xBDA8FAE9, 0xBE8838D4
)

func kernelSin(x, y float64, iy int) float64 {
	ix := hiWord(x) & 0x7fffffff
	if ix < 0x3e400000 { // |x| < 2^-27
		if int(x) == 0 {
			return x
		}
	}
	z := x * x
	v := z * x
	r := ksS2 + z*(ksS3+z*(ksS4+z*(ksS5+z*ksS6)))
	if iy == 0 {
		return x + v*(ksS1+z*r)
	}
	return x - ((z*(ksHalf*y-v*r) - y) - v*ksS1)
}

func kernelCos(x, y float64) float64 {
	ix := hiWord(x) & 0x7fffffff
	if ix < 0x3e400000 { // |x| < 2^-27
		if int(x) == 0 {
			return 1.0
		}
	}
	z := x * x
	r := z * (kcC1 + z*(kcC2+z*(kcC3+z*(kcC4+z*(kcC5+z*kcC6)))))
	if ix < 0x3FD33333 { // |x| < 0.3
		return 1.0 - (0.5*z - (z*r - x*y))
	}
	var qx float64
	if ix > 0x3fe90000 { // x > 0.78125
		qx = 0.28125
	} else {
		qx = fromWords(ix-0x00200000, 0) // x/4
	}
	hz := 0.5*z - qx
	a := 1.0 - qx
	return a - (hz - (z*r - x*y))
}

const (
	rpInvPio2 = 6.36619772367581382433e-01 // 0x3FE45F30, 0x6DC9C883
	rpPio21   = 1.57079632673412561417e+00 // 0x3FF921FB, 0x54400000
	rpPio21t  = 6.07710050650619224932e-11 // 0x3DD0B461, 0x1A626331
	rpPio22   = 6.07710050630396597660e-11 // 0x3DD0B461, 0x1A600000
	rpPio22t  = 2.02226624879595063154e-21 // 0x3BA3198A, 0x2E037073
	rpPio23   = 2.02226624871116645580e-21 // 0x3BA3198A, 0x2E000000
	rpPio23t  = 8.47842766036889956997e-32 // 0x397B839A, 0x252049C1
)

var npio2hw = [32]int32{
	0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C,
	0x4025FDBB, 0x402921FB, 0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C,
	0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB, 0x403AB41B, 0x403C463A,
	0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
	0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB,
	0x404858EB, 0x404921FB,
}

// remPio2 reduces x modulo pi/2 for |x| <= 2^19*(pi/2). ok=false above that
// (the large-argument path is never reached by coordinates in radians).
func remPio2(x float64) (n int32, y0, y1 float64, ok bool) {
	hx := hiWord(x)
	ix := hx & 0x7fffffff
	if ix <= 0x3fe921fb { // |x| ~<= pi/4
		return 0, x, 0, true
	}
	if ix < 0x4002d97c { // |x| < 3pi/4, n = +-1
		if hx > 0 {
			z := x - rpPio21
			if ix != 0x3ff921fb {
				y0 = z - rpPio21t
				y1 = (z - y0) - rpPio21t
			} else {
				z -= rpPio22
				y0 = z - rpPio22t
				y1 = (z - y0) - rpPio22t
			}
			return 1, y0, y1, true
		}
		z := x + rpPio21
		if ix != 0x3ff921fb {
			y0 = z + rpPio21t
			y1 = (z - y0) + rpPio21t
		} else {
			z += rpPio22
			y0 = z + rpPio22t
			y1 = (z - y0) + rpPio22t
		}
		return -1, y0, y1, true
	}
	if ix <= 0x413921fb { // |x| ~<= 2^19*(pi/2)
		t := math.Abs(x)
		n = int32(t*rpInvPio2 + ksHalf)
		fn := float64(n)
		r := t - fn*rpPio21
		w := fn * rpPio21t
		if n < 32 && ix != npio2hw[n-1] {
			y0 = r - w
		} else {
			j := ix >> 20
			y0 = r - w
			i := j - ((hiWord(y0) >> 20) & 0x7ff)
			if i > 16 {
				t = r
				w = fn * rpPio22
				r = t - w
				w = fn*rpPio22t - ((t - r) - w)
				y0 = r - w
				i = j - ((hiWord(y0) >> 20) & 0x7ff)
				if i > 49 {
					t = r
					w = fn * rpPio23
					r = t - w
					w = fn*rpPio23t - ((t - r) - w)
					y0 = r - w
				}
			}
		}
		y1 = (r - y0) - w
		if hx < 0 {
			return -n, -y0, -y1, true
		}
		return n, y0, y1, true
	}
	return 0, 0, 0, false
}

func fdSin(x float64) float64 {
	ix := hiWord(x) & 0x7fffffff
	if ix <= 0x3fe921fb {
		return kernelSin(x, 0, 0)
	}
	if ix >= 0x7ff00000 {
		return math.NaN()
	}
	n, y0, y1, ok := remPio2(x)
	if !ok {
		return math.Sin(x)
	}
	switch n & 3 {
	case 0:
		return kernelSin(y0, y1, 1)
	case 1:
		return kernelCos(y0, y1)
	case 2:
		return -kernelSin(y0, y1, 1)
	default:
		return -kernelCos(y0, y1)
	}
}

func fdCos(x float64) float64 {
	ix := hiWord(x) & 0x7fffffff
	if ix <= 0x3fe921fb {
		return kernelCos(x, 0)
	}
	if ix >= 0x7ff00000 {
		return math.NaN()
	}
	n, y0, y1, ok := remPio2(x)
	if !ok {
		return math.Cos(x)
	}
	switch n & 3 {
	case 0:
		return kernelCos(y0, y1)
	case 1:
		return -kernelSin(y0, y1, 1)
	case 2:
		return -kernelCos(y0, y1)
	default:
		return kernelSin(y0, y1, 1)
	}
}
