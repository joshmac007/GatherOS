import React, { useMemo } from 'react';
import ImageCard from './ImageCard.jsx';
import styles from './Grid.module.css';

function FavoritesHeartGraphic() {
  // Designer-supplied embossed heart with cumulative outer shadows + a
  // top inner highlight. IDs prefixed with mm-fav- so they don't collide
  // with anything else if more than one SVG with auto-generated ids ever
  // ends up on the page.
  return (
    <svg
      viewBox="0 0 159 159"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <g filter="url(#mm-fav-shadows)">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M64.9708 52.0439C69.5933 52.3789 74.4099 54.6322 79.0207 59.1927C83.6303 54.6335 88.4426 52.3844 93.0609 52.0569C98.273 51.6873 102.881 53.7939 106.215 57.1175C112.769 63.6521 114.827 75.4766 106.694 83.6099C106.667 83.6373 106.638 83.6641 106.61 83.6901L80.6031 107.247C79.7049 108.06 78.3363 108.06 77.4382 107.247L51.4315 83.6901C51.4027 83.6641 51.3746 83.6373 51.3472 83.6099C43.1715 75.4342 45.2188 63.6084 51.7948 57.0788C55.1367 53.7604 59.7538 51.6659 64.9708 52.0439Z"
          fill="url(#mm-fav-gradient)"
        />
        <path
          d="M52.1475 57.4336C55.4008 54.2032 59.8806 52.1768 64.9346 52.543C69.4137 52.8675 74.1238 55.0524 78.6689 59.5479L79.0205 59.8955L79.3721 59.5479C83.9161 55.0535 88.6222 52.873 93.0967 52.5557C98.1451 52.1978 102.616 54.236 105.861 57.4717C112.265 63.856 114.236 75.3602 106.341 83.2559L106.34 83.2568C106.319 83.2774 106.298 83.2984 106.274 83.3193L80.2676 106.877C79.5599 107.518 78.481 107.518 77.7734 106.877L51.7676 83.3193H51.7666C51.7443 83.2991 51.7229 83.2776 51.7012 83.2559C43.7621 75.3168 45.7243 63.8114 52.1475 57.4336Z"
          stroke="black"
          strokeOpacity="0.05"
        />
      </g>
      <defs>
        <filter
          id="mm-fav-shadows"
          x="40"
          y="48"
          width="105.003"
          height="108.857"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dx="1" dy="2" />
          <feGaussianBlur stdDeviation="2.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.05 0" />
          <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dx="4" dy="9" />
          <feGaussianBlur stdDeviation="5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.04 0" />
          <feBlend mode="normal" in2="effect1_dropShadow" result="effect2_dropShadow" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dx="10" dy="19" />
          <feGaussianBlur stdDeviation="6.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.02 0" />
          <feBlend mode="normal" in2="effect2_dropShadow" result="effect3_dropShadow" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dx="18" dy="34" />
          <feGaussianBlur stdDeviation="7.5" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.01 0" />
          <feBlend mode="normal" in2="effect3_dropShadow" result="effect4_dropShadow" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="-4" />
          <feGaussianBlur stdDeviation="4.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0" />
          <feBlend mode="normal" in2="shape" result="effect5_innerShadow" />
        </filter>
        <linearGradient
          id="mm-fav-gradient"
          x1="79.0014"
          y1="52"
          x2="79.0014"
          y2="107.857"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="white" />
          <stop offset="1" stopColor="#D9D9D9" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export default function Grid({ saves, selected, onSelect, onOpen, onContextMenu, columns, loading, view }) {
  const columnBuckets = useMemo(() => {
    const buckets = Array.from({ length: columns }, () => []);
    saves.forEach((save, i) => {
      buckets[i % columns].push(save);
    });
    return buckets;
  }, [saves, columns]);

  if (loading && saves.length === 0) {
    return <div className={styles.state} />;
  }

  if (saves.length === 0) {
    const isCollection = view?.type === 'collection';
    const isFavorites = view?.type === 'favorites';

    let title = 'Nothing saved yet';
    let hint = 'Press ⌘⇧S to screenshot, or drag images into this window';
    if (isCollection) {
      title = 'Collection is empty';
      hint = 'Right-click any image and choose "Add to Collection"';
    } else if (isFavorites) {
      title = 'No favorites yet';
      hint = 'Click the heart on any image to favorite it';
    }

    return (
      <div className={styles.state}>
        {isCollection && (
          <div className={styles.emptyGraphic} aria-hidden="true">
            <div className={styles.blobs}>
              <div className={styles.blobA} />
              <div className={styles.blobB} />
              <div className={styles.blobC} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardA}`}>
              <div className={styles.glassCard} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardB}`}>
              <div className={styles.glassCard} />
            </div>
            <div className={`${styles.glassCardWrap} ${styles.cardC}`}>
              <div className={styles.glassCard} />
            </div>
          </div>
        )}
        {isFavorites && (
          <div className={styles.heartHero} aria-hidden="true">
            <FavoritesHeartGraphic />
          </div>
        )}
        <div className={styles.emptyTitle}>{title}</div>
        <div className={styles.emptyHint}>{hint}</div>
      </div>
    );
  }

  return (
    <div
      className={styles.grid}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {columnBuckets.map((bucket, colIdx) => (
        <div key={colIdx} className={styles.column}>
          {bucket.map((s) => (
            <ImageCard
              key={s.id}
              record={s}
              selected={selected.has(s.id)}
              selectionActive={selected.size > 0}
              onSelect={onSelect}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
