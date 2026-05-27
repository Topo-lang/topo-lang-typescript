export function processOrder(orderId: number): number {
    return orderId * 2;
}

export function calculateTotal(count: number): number {
    let sum = 0;
    for (let i = 1; i <= count; i++) sum += i;
    return sum;
}
