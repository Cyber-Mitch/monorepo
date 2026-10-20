'use client'

import * as React from 'react'

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

interface ModalDialogProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
}

/** Controlled modal wrapper (isOpen/onClose) over the shared Radix dialog. */
export function ModalDialog({ isOpen, onClose, children }: Readonly<ModalDialogProps>) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle className="sr-only">Dialog</DialogTitle>
        <DialogDescription className="sr-only">Admin action dialog</DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  )
}
