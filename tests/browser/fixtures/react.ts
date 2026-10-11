// Route-fulfilled fixture HTML is not transformed by Vite. Import React through
// this real module so Vite applies CommonJS interop and uses the same optimized
// module URLs as the components under test, preserving a single React instance.
import React from 'react'

export default React
export { useRef, useState } from 'react'
export { createRoot } from 'react-dom/client'
