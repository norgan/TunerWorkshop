// Metadata candidates recovered from the supplied MiTo project; no calibration bytes.
export const referenceCatalogue = {
  "sourceLabel": "Alfa Romeo MiTo · 1.4 Turbo MultiAir · IAW 8GMF",
  "sourceSha256": "6221e42b17c12c7a475c082c82ef3c9a09de7f9aa161897954bcf89f9cba453b",
  "readyToApply": false,
  "targetFiat8gmkMatchVerified": false,
  "rawImageRecovered": false,
  "candidates": [
    {
      "symbol": "TBDPREUTHDYN",
      "description": "Upstream Throttle Pressure static target",
      "category": "boost",
      "referenceAddress": 1346112,
      "dimensions": [
        14,
        16
      ],
      "unit": "mBar",
      "factor": 1.0,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "TBDUTYNQAHRP",
      "description": "Nominal percentage opening wastegate Table on RP and QAH of compressor.",
      "category": "boost",
      "referenceAddress": 1349738,
      "dimensions": [
        14,
        16
      ],
      "unit": "[unresolved string token -3]",
      "factor": 0.015625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "TBRPCOMPLIM",
      "description": "Compressor pressure ratio limit for pumping and speed",
      "category": "boost",
      "referenceAddress": 1347856,
      "dimensions": [
        10,
        24
      ],
      "unit": "adim",
      "factor": 6.103515625e-05,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "TBDPTURBO",
      "description": "Table for Turbo base delta pressure close to oxygen sensor",
      "category": "boost",
      "referenceAddress": 1353008,
      "dimensions": [
        14,
        16
      ],
      "unit": "mBar",
      "factor": 1.0,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "KFILTRPBST",
      "description": "RP compressor target low pass filter gain.",
      "category": "boost",
      "referenceAddress": 1349180,
      "dimensions": [
        7,
        9
      ],
      "unit": "[unresolved string token -1]",
      "factor": 6.103515625e-05,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "TBACLOAD",
      "description": "compressor load interpolation table",
      "category": "boost",
      "referenceAddress": 1372196,
      "dimensions": [
        8,
        8
      ],
      "unit": "Nm",
      "factor": 0.0625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "PQAV",
      "description": "Base spark advance in Homogeneous mode",
      "category": "ignition",
      "referenceAddress": 1389964,
      "dimensions": [
        14,
        20
      ],
      "unit": "deg",
      "factor": 0.0625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "PQLAMMP",
      "description": "Table for Base Hot Lambda ",
      "category": "fuel",
      "referenceAddress": 1380018,
      "dimensions": [
        14,
        20
      ],
      "unit": "no dim.",
      "factor": 0.0009765625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "PQLAMMPC",
      "description": "Table for Base Cold Lambda",
      "category": "fuel",
      "referenceAddress": 1380578,
      "dimensions": [
        14,
        20
      ],
      "unit": "no dim.",
      "factor": 0.0009765625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    },
    {
      "symbol": "PQLAM_MIN",
      "description": "Minimum Lambda Table",
      "category": "fuel",
      "referenceAddress": 1393388,
      "dimensions": [
        6,
        20
      ],
      "unit": "no dim.",
      "factor": 0.0009765625,
      "offset": 0.0,
      "bytesPerCell": 2.0
    }
  ]
};
