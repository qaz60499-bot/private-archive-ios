import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

export function MotionDirector() {
  const location = useLocation()

  useEffect(() => {
    const root = document.querySelector<HTMLElement>('#main-content')
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!root || reduceMotion) return

    let cancelled = false
    let cleanup: (() => void) | undefined

    void (async () => {
      const { gsap } = await import('gsap')
      if (cancelled) return

      const atmosphere = document.querySelector<HTMLElement>('.archive-atmosphere')
      const atmosphereLayers = atmosphere?.querySelectorAll<HTMLElement>('.archive-atmosphere-fallback, canvas')
      const exposureVeil = document.querySelector<HTMLElement>('.route-exposure-veil')
      const activeCore = document.querySelectorAll<SVGElement>('.desktop-sidebar .rail-link.active .glyph-core, .mobile-bottom-nav a.active .glyph-core')
      const activeOrbit = document.querySelectorAll<SVGElement>('.desktop-sidebar .rail-link.active .glyph-orbit, .mobile-bottom-nav a.active .glyph-orbit')

      const context = gsap.context(() => {
        const route = gsap.timeline({ defaults: { ease: 'power3.out' } })
        if (atmosphereLayers?.length) {
          route.fromTo(
            atmosphereLayers,
            { scale: 1.016, transformOrigin: '50% 50%' },
            { scale: 1, duration: 1.15, clearProps: 'transform,transformOrigin' },
            0,
          )
        }
        if (exposureVeil) {
          route.fromTo(
            exposureVeil,
            { autoAlpha: .72, scale: 1.08 },
            { autoAlpha: 0, scale: 1, duration: 1.12, ease: 'power2.out', clearProps: 'transform,visibility' },
            0,
          )
        }
        if (activeCore.length) {
          route.fromTo(
            activeCore,
            { scale: .8, rotation: -10, transformOrigin: '50% 50%' },
            { scale: 1, rotation: 0, duration: .68, ease: 'back.out(1.65)', clearProps: 'transform' },
            .08,
          )
        }
        if (activeOrbit.length) {
          route.fromTo(activeOrbit, { strokeDashoffset: 82 }, { strokeDashoffset: 0, duration: .86, ease: 'power2.out' }, .08)
        }

        const memoryAperture = root.querySelector<HTMLElement>('.memory-aperture')
        if (memoryAperture) {
          const eyebrow = memoryAperture.querySelector('.eyebrow')
          const title = memoryAperture.querySelector('h1')
          const description = memoryAperture.querySelector('.memory-aperture-copy > p:not(.eyebrow)')
          const stats = memoryAperture.querySelector('.archive-hero-stats')
          const actions = memoryAperture.querySelector('.archive-hero-actions')
          const heroTimeline = gsap.timeline({ defaults: { ease: 'power3.out' } })

          if (eyebrow) heroTimeline.fromTo(eyebrow, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: .3, clearProps: 'transform,opacity,visibility' })
          if (title) heroTimeline.fromTo(title, { autoAlpha: 0, y: 16, scale: .994 }, { autoAlpha: 1, y: 0, scale: 1, duration: .56, clearProps: 'transform,opacity,visibility' }, '-=.1')
          if (description) heroTimeline.fromTo(description, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: .4, clearProps: 'transform,opacity,visibility' }, '-=.28')
          if (stats) heroTimeline.fromTo(stats, { autoAlpha: 0, y: 7 }, { autoAlpha: 1, y: 0, duration: .36, clearProps: 'transform,opacity,visibility' }, '-=.25')
          if (actions) heroTimeline.fromTo(actions, { autoAlpha: 0, y: 6 }, { autoAlpha: 1, y: 0, duration: .32, clearProps: 'transform,opacity,visibility' }, '-=.22')
          // The Archive Composition is already painted by CSS/DOM. Do not hide it,
          // pin it, scrub it, or load ScrollTrigger solely for decorative hero motion.
        }

        const intro = root.querySelector<HTMLElement>('.page-intro')
        if (intro) {
          const eyebrow = intro.querySelector('.eyebrow')
          const title = intro.querySelector('h1')
          const description = intro.querySelector(':scope > div:first-child > p:last-child')
          const count = intro.querySelector('.accession-count')
          const introTimeline = gsap.timeline({ defaults: { ease: 'power3.out' } })
          if (eyebrow) introTimeline.fromTo(eyebrow, { autoAlpha: 0, y: 9 }, { autoAlpha: 1, y: 0, duration: .42, clearProps: 'transform,opacity,visibility' })
          if (title) introTimeline.fromTo(title, { autoAlpha: 0, y: 24, scale: .992 }, { autoAlpha: 1, y: 0, scale: 1, duration: .78, clearProps: 'transform,opacity,visibility' }, '-=.2')
          if (description) introTimeline.fromTo(description, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: .56, clearProps: 'transform,opacity,visibility' }, '-=.42')
          if (count) introTimeline.fromTo(count, { autoAlpha: 0, x: 12 }, { autoAlpha: 1, x: 0, duration: .54, clearProps: 'transform,opacity,visibility' }, '-=.5')
        }
      }, root)

      const intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const section = entry.target as HTMLElement
          const rule = section.querySelector('.folio-rule')
          const date = section.querySelector('.folio-heading > div:nth-child(2)')
          const index = section.querySelector('.folio-heading > span')
          const tiles = section.querySelectorAll('.media-tile')
          const timeline = gsap.timeline({ defaults: { ease: 'power3.out' } })

          if (rule) timeline.fromTo(rule, { scaleY: 0, transformOrigin: 'top' }, { scaleY: 1, duration: .5, clearProps: 'transform' })
          if (date) timeline.fromTo(date, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: .5, clearProps: 'transform,opacity,visibility' }, '<.05')
          if (index) timeline.fromTo(index, { autoAlpha: 0, x: 8 }, { autoAlpha: 1, x: 0, duration: .42, clearProps: 'transform,opacity,visibility' }, '<.08')
          if (tiles.length) {
            timeline.fromTo(
              tiles,
              {
                autoAlpha: 0,
                y: (itemIndex) => 16 + (itemIndex % 3) * 3,
                rotation: (itemIndex) => itemIndex % 2 ? .22 : -.22,
                scale: .994,
              },
              {
                autoAlpha: 1,
                y: 0,
                rotation: 0,
                scale: 1,
                duration: .58,
                stagger: { each: .042, from: 'start' },
                clearProps: 'transform,opacity,visibility',
              },
              '-=.22',
            )
          }

          section.dataset.motionShown = 'true'
          intersectionObserver.unobserve(section)
        }
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })

      const bindSections = () => {
        root.querySelectorAll<HTMLElement>('.timeline-section:not([data-motion-bound])').forEach((section) => {
          section.dataset.motionBound = 'true'
          intersectionObserver.observe(section)
        })
      }

      bindSections()
      const mutationObserver = new MutationObserver(bindSections)
      mutationObserver.observe(root, { childList: true, subtree: true })

      cleanup = () => {
        mutationObserver.disconnect()
        intersectionObserver.disconnect()
        context.revert()
        root.querySelectorAll<HTMLElement>('[data-motion-bound]').forEach((element) => {
          delete element.dataset.motionBound
          delete element.dataset.motionShown
        })
      }
    })().catch(() => undefined)

    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [location.key])

  return null
}
