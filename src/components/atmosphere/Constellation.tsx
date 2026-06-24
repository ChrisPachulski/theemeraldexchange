import './Constellation.css'

// Decorative-only constellation overlay. Pure SVG, no JS animation —
// the drift is handled by a CSS transform animation on the parent
// (.constellation__sky). At ~6% effective opacity over the body radial
// fog, it adds depth without weight.
//
// Points are pre-computed in viewBox coordinates; ratios are picked so
// the network feels stargazed, not engineered: clusters of 3–4 nearby
// points connected by hairlines, with gaps between clusters.

const POINTS: Array<[number, number]> = [
  [120, 90], [185, 60], [255, 130], [340, 75], [420, 160],
  [70, 220], [195, 240], [310, 280], [445, 245], [560, 195],
  [40, 360], [165, 380], [295, 410], [430, 395], [555, 355], [680, 305],
  [110, 510], [225, 540], [360, 565], [490, 530], [615, 490], [740, 445],
  [60, 670], [200, 695], [340, 720], [480, 700], [620, 660], [770, 615],
  [150, 820], [300, 845], [445, 870], [600, 850], [750, 805], [890, 770],
  [840, 130], [920, 90], [1010, 165], [1100, 110], [1190, 195],
  [870, 290], [990, 320], [1110, 295], [1230, 365],
  [800, 460], [930, 490], [1060, 470], [1190, 525], [1310, 495],
  [880, 615], [1010, 645], [1140, 625], [1280, 685],
  [820, 770], [970, 800], [1100, 825], [1240, 800], [1380, 760],
]

const LINES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 9],
  [5, 6], [6, 7], [7, 8], [8, 9],
  [10, 11], [11, 12], [12, 13], [13, 14], [14, 15],
  [16, 17], [17, 18], [18, 19], [19, 20], [20, 21],
  [22, 23], [23, 24], [24, 25], [25, 26], [26, 27],
  [28, 29], [29, 30], [30, 31], [31, 32], [32, 33],
  [34, 35], [35, 36], [36, 37], [37, 38],
  [38, 39], [39, 40], [40, 41],
  [42, 43], [43, 44], [44, 45], [45, 46],
  [47, 48], [48, 49], [49, 50],
  [51, 52], [52, 53], [53, 54], [54, 55],
  [4, 35], [9, 38], [15, 42], [21, 46], [27, 50], [33, 55],
]

export function Constellation() {
  return (
    <div className="constellation" aria-hidden="true">
      <svg
        className="constellation__sky"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
      >
        <g className="constellation__lines">
          {LINES.map(([a, b], i) => (
            <line
              key={i}
              x1={POINTS[a][0]}
              y1={POINTS[a][1]}
              x2={POINTS[b][0]}
              y2={POINTS[b][1]}
            />
          ))}
        </g>
        <g className="constellation__dots">
          {POINTS.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.2} />
          ))}
        </g>
      </svg>
    </div>
  )
}
