import React, { useCallback } from 'react';
import path from 'path';
import { useDispatch } from 'react-redux';
import { browseFile } from 'providers/ReduxStore/slices/collections/actions';
import { IconX } from '@tabler/icons';
import { isWindowsOS } from 'utils/common/platform';
import slash from 'utils/common/slash';

const RawFilePickerEditor = ({ value = '', onChange, collection }) => {
  const dispatch = useDispatch();
  const separator = isWindowsOS() ? '\\' : '/';
  const filename = value ? value.split(separator).pop() : '';
  const title = `- ${filename}`;

  const browse = useCallback(() => {
    dispatch(browseFile(true))
      .then((filePath) => {
        const collectionDir = collection.pathname;
        const relativePath = filePath.startsWith(collectionDir)
          ? path.relative(slash(collectionDir), slash(filePath))
          : filePath;
        onChange(relativePath);
      })
      .catch((error) => {
        console.error(error);
      });
  }, [dispatch, collection.pathname, onChange]);

  const clear = useCallback(() => {
    onChange(null);
  }, [onChange]);

  return (
    <div className="btn-secondary p-2 rounded w-full text-ellipsis overflow-x-hidden" title={title}>
      {filename ? (
        <>
          <button className="align-middle" onClick={clear}>
            <IconX size={18} />
          </button>
          &nbsp;
          {filename}
        </>
      ) : (
        <button className="btn-secondary p-2 rounded w-full" onClick={browse}>
          Select File
        </button>
      )}
    </div>
  );
};

export default RawFilePickerEditor;
