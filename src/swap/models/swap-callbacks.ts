export interface SwapCallbacks {
    onConfirm?: (hash: string) => void;
    onApprove?: (hash: string | null) => void;
}
