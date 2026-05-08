import React from 'react';
import { FolderClosed } from 'lucide-react';
import styles from './FolderGrid.module.css';
import { fileUrl } from '../lib/fileUrl.js';

// One tile per folder. Promotes the bucketStackDeal hover-fan from
// an Easter egg in the sidebar into the primary navigation artwork.
// On hover the back/front cards spread further apart so the row
// reads as alive — same idiom we use everywhere a stack appears.
function FolderTile({ folder, onClick, onContextMenu }) {
  const thumbs = Array.isArray(folder.thumbs) ? folder.thumbs.slice(0, 3) : [];
  return (
    <button
      type="button"
      className={styles.tile}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div className={styles.tileArt}>
        {thumbs.length > 0 ? (
          <div className={styles.tileStack} aria-hidden="true">
            {thumbs.map((thumb, i) => (
              <img
                key={`${i}-${thumb}`}
                src={fileUrl(thumb)}
                className={styles.tileStackImg}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            ))}
          </div>
        ) : (
          <span className={styles.tileEmpty} aria-hidden="true">
            <FolderClosed size={36} strokeWidth={1.4} />
          </span>
        )}
      </div>
      <div className={styles.tileMeta}>
        <span className={styles.tileName}>{folder.name}</span>
        {folder.save_count > 0 && (
          <span className={styles.tileCount}>{folder.save_count}</span>
        )}
      </div>
    </button>
  );
}

// Renders all collections at a given parent level as a tile grid.
// `parentId === null` shows root-level folders; non-null drills into
// a parent's children. Click handler escalates to the App layer
// which decides what "open this folder" actually means (drill into
// children vs. switch to masonry of saves).
export default function FolderGrid({
  folders,
  parentId = null,
  onPickFolder,
  onCreateFolder,
  onContextMenu,
}) {
  const visible = (folders || []).filter(
    (f) => (f.parent_id || null) === parentId,
  );

  if (visible.length === 0) {
    return (
      <div className={styles.empty}>
        <FolderClosed size={36} strokeWidth={1.3} className={styles.emptyIcon} />
        <div className={styles.emptyTitle}>No folders yet</div>
        <div className={styles.emptyHint}>
          Folders organise saves by project, mood, or anything else.
        </div>
        {onCreateFolder && (
          <button
            type="button"
            className={styles.emptyAction}
            onClick={onCreateFolder}
          >
            Create your first folder
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        {visible.map((folder) => (
          <FolderTile
            key={folder.id}
            folder={folder}
            onClick={() => onPickFolder(folder.id)}
            onContextMenu={onContextMenu ? (e) => onContextMenu(e, folder) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
