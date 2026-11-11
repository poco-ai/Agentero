use crate::enums::{
    TessOrientation, TessPageIteratorLevel, TessParagraphJustification, TessPolyBlockType,
    TessTextlineOrder, TessWritingDirection,
};
use crate::error::{Result, TesseractError};
use std::os::raw::{c_float, c_int, c_void};
use std::sync::Arc;
use std::sync::Mutex;

pub struct PageIterator {
    pub handle: Arc<Mutex<*mut c_void>>,
}

unsafe impl Send for PageIterator {}
unsafe impl Sync for PageIterator {}

impl PageIterator {
    /// Creates a new instance of the PageIterator.
    ///
    /// # Arguments
    ///
    /// * `handle` - Pointer to the PageIterator.
    ///
    /// # Returns
    ///
    /// Returns the new instance of the PageIterator.
    pub fn new(handle: *mut c_void) -> Self {
        PageIterator {
            handle: Arc::new(Mutex::new(handle)),
        }
    }

    /// Begins the iteration.
    pub fn begin(&self) -> Result<()> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        unsafe { TessPageIteratorBegin(*handle) };
        Ok(())
    }

    /// Gets the next iterator.
    ///
    /// # Arguments
    ///
    /// * `level` - Level of the iterator.
    ///
    /// # Returns
    ///
    /// Returns `true` if the next iterator is successful, otherwise returns `false`.
    pub fn next(&self, level: TessPageIteratorLevel) -> Result<bool> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        Ok(unsafe { TessPageIteratorNext(*handle, level as c_int) != 0 })
    }

    /// Checks if the current iterator is at the beginning of the specified level.
    ///
    /// # Arguments
    ///
    /// * `level` - Level of the iterator.
    ///
    /// # Returns
    ///
    /// Returns `true` if the current iterator is at the beginning of the specified level, otherwise returns `false`.
    pub fn is_at_beginning_of(&self, level: TessPageIteratorLevel) -> Result<bool> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        Ok(unsafe { TessPageIteratorIsAtBeginningOf(*handle, level as c_int) != 0 })
    }

    /// Checks if the current iterator is at the final element of the specified level.
    ///
    /// # Arguments
    ///
    /// * `level` - Level of the iterator.
    /// * `element` - Element of the iterator.
    ///
    /// # Returns
    ///
    /// Returns `true` if the current iterator is at the final element of the specified level, otherwise returns `false`.
    pub fn is_at_final_element(
        &self,
        level: TessPageIteratorLevel,
        element: TessPageIteratorLevel,
    ) -> Result<bool> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        Ok(unsafe {
            TessPageIteratorIsAtFinalElement(*handle, level as c_int, element as c_int) != 0
        })
    }

    /// Gets the bounding box of the current iterator.
    ///
    /// # Arguments
    ///
    /// * `level` - Level of the bounding box.
    ///
    /// # Returns
    ///
    /// Returns the bounding box as a tuple if successful, otherwise returns an error.
    pub fn bounding_box(&self, level: TessPageIteratorLevel) -> Result<(i32, i32, i32, i32)> {
        let mut left = 0;
        let mut top = 0;
        let mut right = 0;
        let mut bottom = 0;
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        let result = unsafe {
            TessPageIteratorBoundingBox(
                *handle,
                level as c_int,
                &mut left,
                &mut top,
                &mut right,
                &mut bottom,
            )
        };
        if result == 0 {
            Err(TesseractError::InvalidParameterError)
        } else {
            Ok((left, top, right, bottom))
        }
    }

    /// Gets the block type of the current iterator.
    ///
    /// # Returns
    ///
    /// Returns the block type as a `TessPolyBlockType`.
    pub fn block_type(&self) -> Result<TessPolyBlockType> {
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        let block_type = unsafe { TessPageIteratorBlockType(*handle) };
        Ok(TessPolyBlockType::from_int(block_type))
    }

    /// Gets the baseline of the current iterator.
    ///
    /// # Arguments
    ///
    /// * `level` - Level of the baseline.
    ///
    /// # Returns
    ///
    /// Returns the baseline as a tuple if successful, otherwise returns an error.
    pub fn baseline(&self, level: i32) -> Result<(i32, i32, i32, i32)> {
        let mut x1 = 0;
        let mut y1 = 0;
        let mut x2 = 0;
        let mut y2 = 0;
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        let result =
            unsafe { TessPageIteratorBaseline(*handle, level, &mut x1, &mut y1, &mut x2, &mut y2) };
        if result == 0 {
            Err(TesseractError::InvalidParameterError)
        } else {
            Ok((x1, y1, x2, y2))
        }
    }

    /// Gets the orientation of the current iterator.
    ///
    /// # Returns
    ///
    /// Returns the orientation as a tuple if successful, otherwise returns an error.
    pub fn orientation(
        &self,
    ) -> Result<(
        TessOrientation,
        TessWritingDirection,
        TessTextlineOrder,
        f32,
    )> {
        let mut orientation = 0;
        let mut writing_direction = 0;
        let mut textline_order = 0;
        let mut deskew_angle = 0.0;
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        let result = unsafe {
            TessPageIteratorOrientation(
                *handle,
                &mut orientation,
                &mut writing_direction,
                &mut textline_order,
                &mut deskew_angle,
            )
        };
        if result == 0 {
            Err(TesseractError::InvalidParameterError)
        } else {
            Ok((
                TessOrientation::from_int(orientation),
                TessWritingDirection::from_int(writing_direction),
                TessTextlineOrder::from_int(textline_order),
                deskew_angle,
            ))
        }
    }

    /// Gets the paragraph information of the current iterator.
    ///
    /// # Returns
    ///
    /// Returns the paragraph information as a tuple if successful, otherwise returns an error.
    pub fn paragraph_info(&self) -> Result<(TessParagraphJustification, bool, bool, i32)> {
        let mut justification = 0;
        let mut is_list_item = false;
        let mut is_crown = false;
        let mut first_line_indent = 0;
        let handle = self
            .handle
            .lock()
            .map_err(|_| TesseractError::MutexLockError)?;
        let result = unsafe {
            TessPageIteratorParagraphInfo(
                *handle,
                &mut justification,
                &mut is_list_item,
                &mut is_crown,
                &mut first_line_indent,
            )
        };
        if result == 0 {
            Err(TesseractError::InvalidParameterError)
        } else {
            Ok((
                TessParagraphJustification::from_int(justification),
                is_list_item,
                is_crown,
                first_line_indent,
            ))
        }
    }
}

impl Drop for PageIterator {
    fn drop(&mut self) {
        if let Ok(handle) = self.handle.lock() {
            unsafe { TessPageIteratorDelete(*handle) };
        }
    }
}

#[cfg(feature = "build-tesseract")]
#[link(name = "tesseract")]
extern "C" {
    pub fn TessPageIteratorDelete(handle: *mut c_void);
    pub fn TessPageIteratorBegin(handle: *mut c_void);
    pub fn TessPageIteratorNext(handle: *mut c_void, level: c_int) -> c_int;
    pub fn TessPageIteratorIsAtBeginningOf(handle: *mut c_void, level: c_int) -> c_int;
    pub fn TessPageIteratorIsAtFinalElement(
        handle: *mut c_void,
        level: c_int,
        element: c_int,
    ) -> c_int;
    pub fn TessPageIteratorBoundingBox(
        handle: *mut c_void,
        level: c_int,
        left: *mut c_int,
        top: *mut c_int,
        right: *mut c_int,
        bottom: *mut c_int,
    ) -> c_int;
    pub fn TessPageIteratorBlockType(handle: *mut c_void) -> c_int;
    pub fn TessPageIteratorBaseline(
        handle: *mut c_void,
        level: c_int,
        x1: *mut c_int,
        y1: *mut c_int,
        x2: *mut c_int,
        y2: *mut c_int,
    ) -> c_int;
    pub fn TessPageIteratorOrientation(
        handle: *mut c_void,
        orientation: *mut c_int,
        writing_direction: *mut c_int,
        textline_order: *mut c_int,
        deskew_angle: *mut c_float,
    ) -> c_int;
    pub fn TessBaseAPIGetIterator(handle: *mut c_void) -> *mut c_void;
    pub fn TessPageIteratorParagraphInfo(
        handle: *mut c_void,
        justification: *mut c_int,
        is_list_item: *mut bool,
        is_crown: *mut bool,
        first_line_indent: *mut c_int,
    ) -> c_int;
}
