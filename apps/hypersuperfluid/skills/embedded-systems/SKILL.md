---
name: embedded-systems
description: Firmware and hardware bring-up - microcontrollers, RTOS, drivers, I2C/SPI/UART/CAN, Arduino, ESP-IDF, STM32, Zephyr, debugging, flashing and power. Load before writing firmware or touching a device.
---

# Embedded systems

## Before writing code

1. Identify the exact part number, board revision, toolchain version and framework. Peripheral behaviour differs between variants of one family.
2. Find the authoritative sources: the datasheet, the reference manual, the errata sheet, and the board schematic. Register addresses, timing, voltage levels and pin functions come from these, never from memory. If you do not have the document, say so and ask for it rather than inventing a register.
3. Read the errata for the silicon revision before debugging a peripheral that "should work".
4. Check the voltage levels and pinout before connecting anything. Hardware damage cannot be undone.

## Actions that wait for a yes

Flashing a device someone else is using, writing option bytes, fuses or eFuses, enabling read protection or secure boot, and erasing a bootloader. Some of these permanently brick the part, so state exactly what the command will do and what cannot be reversed.

## Bring-up order

Prove each layer before building on the next:

1. Power: measure the rails. Then the clock: confirm the frequency you configured is the one you got, by toggling a pin or using MCO.
2. A blinking LED proves toolchain, flash, clock and GPIO.
3. A UART log line gives you eyes. Get this working before anything complicated.
4. One peripheral at a time, each with a minimal test.
5. Then interrupts, DMA, the RTOS, and low power, in that order.

## Debugging

- Have a debugger attached (SWD or JTAG, through OpenOCD, pyOCD, J-Link or `probe-rs`). On a fault, read the fault status registers (CFSR, HFSR, MMFAR, BFAR on Cortex-M) and the stacked PC, then map the address with `addr2line` or the map file.
- For a bus problem, use a logic analyzer or oscilloscope. A protocol decode settles what software guesses cannot.
- I2C: check pull-ups, the 7-bit versus 8-bit address confusion, and run a bus scan first. A NAK at the address means wiring, address or power, not your register logic. A bus stuck low needs nine clock pulses to recover.
- SPI: confirm the mode (CPOL and CPHA), bit order, chip select timing, and clock rate against the datasheet. Start slow.
- UART: confirm baud rate, 3.3 V versus 5 V levels, and TX to RX crossover.
- CAN: needs 120 ohm termination at both ends and a transceiver. A lone node sees ACK errors because nobody acknowledges.

## Code rules

- `volatile` for memory-mapped registers and variables shared with an ISR. It does not make access atomic: guard multi-byte shared data with a critical section or a queue.
- Keep ISRs short: capture the data, signal a task, return. No blocking calls, no logging, no heap in an ISR.
- Do not use dynamic allocation after startup unless the project already does: fragmentation appears after weeks of uptime.
- Watch stack sizes: an overflow corrupts unrelated memory and looks like a random crash. Enable stack checking and read the high-water mark.
- RTOS: use the ISR-safe API variants inside interrupts, avoid priority inversion with priority-inheriting mutexes, and take locks in one global order.
- Check the return value of every peripheral call, and give every wait a timeout. A hung I2C transaction should not hang the product.
- Use fixed-width types (`uint32_t`), and state units in names (`timeout_ms`). Never assume struct packing or endianness on the wire: serialize explicitly.
- Enable a watchdog in production, and feed it from a health check rather than a timer, so a stuck task resets the device.

## Build and flash

Detect what the project uses before proposing commands: `platformio.ini`, `sdkconfig` or `CMakeLists.txt` with `idf_component_register` (ESP-IDF), `prj.conf` and `west.yml` (Zephyr), `*.ioc` (STM32CubeMX), `*.ino` (Arduino).

| Framework | Build | Flash and monitor |
|---|---|---|
| PlatformIO | `pio run` | `pio run -t upload`, `pio device monitor` |
| ESP-IDF | `idf.py build` | `idf.py -p PORT flash monitor` |
| Zephyr | `west build -b BOARD` | `west flash` |
| Arduino CLI | `arduino-cli compile --fqbn FQBN .` | `arduino-cli upload -p PORT --fqbn FQBN .` |
| CMake with OpenOCD | `cmake --build build` | `openocd -f interface.cfg -f target.cfg -c "program build/app.elf verify reset exit"` |

Find serial ports with `pio device list`, `ls /dev/tty*`, or `Get-PnpDevice -Class Ports` on Windows.

## Pitfalls

- Code that works under the debugger and fails without it usually points at timing, an uninitialized variable, or a semihosting call that blocks with no debugger attached.
- A problem that appears at higher optimization levels points at a missing `volatile` or undefined behaviour, not a compiler bug.
- Brownouts look like software crashes. Read the reset cause register at boot and log it.
- Shared-pin conflicts: check strapping pins and which peripherals share a pin before assigning it.

## Verification

Run on real hardware when it is connected, and report what you measured. If no device is available, say clearly that the code compiles but is untested on hardware.
