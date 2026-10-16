# Hostealo Terminal

Cliente open source de SSH, SFTP, FTP y RDP para Windows, macOS, Linux e iOS, con el diseño del
área de clientes de [Hostealo](https://hostealo.es).

> Estado: desarrollo inicial (v0.1.0). Ya funcionan la terminal local, SSH, SFTP, FTP/FTPS y RDP (escritorio
> remoto), el monitor de recursos, los colores, carpetas y logos del sistema operativo de cada servidor (detectado al conectar), la importación desde MobaXterm, Royal TS, PuTTY, FileZilla y OpenSSH, la gestión de claves SSH
> y el limpiador de huellas. El RDP incluye portapapeles compartido (texto, imágenes y archivos),
> audio remoto y una carpeta compartida como unidad. El asistente de IA (con tu propia cuenta de Claude, OpenAI u Ollama)
> responde con la terminal como contexto y propone comandos que insertas o ejecutas con un clic; en modo agente ejecuta él mismo los pasos,
> cada uno con tu aprobación. Al conectar una cuenta de Hostealo, tus VPS y dedicados se añaden solos.
>
> Read in English: [README.md](README.md)

## Funciones previstas

- **Protocolos:** SSH (jump hosts, agente, claves, túneles), SFTP, FTP/FTPS, RDP y terminal local.
- **Monitor de recursos:** barra bajo cada sesión con CPU, RAM, disco, red, carga y tiempo
  encendido. En servidores remotos no hace falta instalar nada: la app lee `/proc` por un segundo
  canal SSH.
- **Asistente de IA:** conecta tu propio proveedor (Claude, OpenAI o modelos locales con Ollama).
  Ve el contexto de la sesión y propone comandos; nada se ejecuta sin tu aprobación.
- **Integración con Hostealo (opcional):** inicia sesión para ver y controlar tus servidores de
  Hostealo. La app funciona igual sin cuenta.
- **Importar:** trae servidores y carpetas de MobaXterm, Royal TS/TSX, PuTTY, FileZilla,
  `~/.ssh/config` de OpenSSH y archivos `.rdp`.
- **Sincronización sin nube:** sincroniza los servidores entre tus dispositivos por la red local
  (se encuentran por Bonjour/mDNS, o se emparejan con un código QR o enlace si la red no deja que
  se vean), cifrado de extremo a extremo (X25519, ChaCha20-Poly1305) y verificado con un código o
  con el secreto del QR. Las contraseñas guardadas, solo si lo marcas. Para un equipo nuevo, una
  copia en un archivo cifrado con contraseña (Argon2id).
- **Comandos rápidos:** comandos guardados que se escriben o ejecutan en la terminal activa con un clic (⌘P); se sincronizan con tus otros dispositivos.
- **Estado y avisos:** los servidores con sesión abierta en directo (CPU, memoria, discos, red), con avisos de disco lleno, memoria o CPU altas de forma sostenida y conexiones perdidas, en la app y como notificaciones del sistema.
- **Buscador (⌘K):** salta a cualquier servidor, pestaña, comando rápido o acción.
- **Docker:** los contenedores de un servidor agrupados por proyecto de Compose, con su consumo, arrancar/parar/reiniciar, logs y una terminal dentro, por SSH normal (con `sudo -n` si el usuario lo necesita).
- **Máquinas virtuales:** en un nodo de Proxmox VE (todo su clúster, con `pvesh`) o un servidor KVM con libvirt como los nodos de SolusVM 2 (con `virsh`): estado, CPU, memoria, disco, encender, apagar ordenadamente, reiniciar, forzar el apagado y consola. Sin claves de API: por SSH, con `sudo -n` si hace falta.
- **Idiomas:** inglés y español.

## Desarrollo

Requisitos: Node.js 20+, Rust (stable) y los
[requisitos de Tauri](https://v2.tauri.app/start/prerequisites/) de tu sistema.

```sh
npm install
npm run dev      # arranca la app con recarga en caliente
npm run build    # genera los instaladores para el sistema actual
```

Demo de la web: la misma interfaz sobre un backend simulado, con una terminal de mentira
(`apps/desktop/src/dev/demo.ts` y `shell.ts`), publicada en `/terminal/demo/` de hostealo.es.
`npm run build:demo -w @hostealo-terminal/desktop` la genera en
`website/terminal/public/terminal/demo/`; en desarrollo, abre `http://localhost:1420/demo.html`.

## Seguridad

- Las contraseñas y frases de paso se guardan solo en el llavero del sistema, nunca en disco.
- La huella del servidor se verifica en cada conexión. Si cambia, se avisa de un posible ataque
  y nunca se acepta en silencio. Se respetan las huellas de `~/.ssh/known_hosts` (solo lectura).

## Licencia

Código: [Functional Source License 1.1, ALv2 Future License](LICENSE) (FSL-1.1-ALv2). El código es
público: puedes leerlo, auditarlo, modificarlo y usarlo, tú o tu empresa, para todo menos para crear
un producto que compita con Hostealo Terminal. Cada versión pasa a Apache License 2.0 a los dos años
de publicarse. El nombre y el logo de Hostealo son marcas registradas y no están cubiertos por la
licencia; consulta [TRADEMARKS.md](TRADEMARKS.md).
